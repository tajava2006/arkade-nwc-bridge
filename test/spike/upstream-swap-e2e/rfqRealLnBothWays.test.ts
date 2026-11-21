/**
 * my-server feasibility check (not upstream): both Lightning directions against the REAL
 * intent-solver + LND on our fork arkd, to completion — not a stub transport.
 *
 *   send:    lnd-peer invoice -> our lockup -> solver pays via lnd -> solver claims with P
 *   receive: solver hold invoice -> lnd-peer pays -> solver funds lockup -> WE claim with P
 *            -> solver settles the held HTLC (payer's payment SUCCEEDED)
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { execSync, spawn } from "child_process";
import { hex } from "@scure/base";
import {
    ArkAddress,
    contractSigner,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestIndexerProvider,
    RestOperatorProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import type { InvoiceFacts } from "../../src";
import {
    httpTransport,
    pushClaim,
    requestLightningReceive,
    requestLightningSend,
} from "../../src/protocol";
import { walletOperator } from "../../src/refund";
import { preimageForSwapRecord, swapSecretsToRecord } from "../../src/store";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const SOLVER_URL = "http://localhost:8787";
const SEND_SATS = 5_000;
/** SM-10: our own emulator's pubkey. Unset = the SDK's network default. */
const EMU = process.env.EMULATOR_PUBKEY_OVERRIDE;
const emu = EMU ? { emulatorPubkey: EMU } : {};
/** SM-10 B: run ONLY the "no override against our emulator" check. */
const MISMATCH_ONLY = process.env.EXPECT_EMULATOR_MISMATCH === "1";
const RECEIVE_SATS = 7_000;

const sh = (command: string): string =>
    execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
const lncli = (node: string, args: string): any =>
    JSON.parse(sh(`docker exec ${node} lncli --network=regtest ${args}`));
const arkdExec = "docker exec arkd";

const waitFor = async (fn: () => Promise<boolean>, what: string, timeout = 180_000) =>
    vi.waitFor(
        async () => {
            if (!(await fn())) throw new Error(`timeout waiting for ${what}`);
        },
        { timeout, interval: 2_000 },
    );

const decodeInvoice = (raw: string): InvoiceFacts => {
    const d = lncli("lnd-peer", `decodepayreq ${raw}`);
    return {
        raw,
        paymentHash: String(d.payment_hash).toLowerCase(),
        amountSats: Number(d.num_satoshis),
        expiresAt: Number(d.timestamp) + Number(d.expiry),
    };
};

const indexer = new RestIndexerProvider(OPERATOR_URL);
let wallet: Wallet;

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    const address = await wallet.getAddress();
    const note = sh(`${arkdExec} arkd note --amount 60000`);
    sh(`${arkdExec} ark redeem-notes -n ${note} --password secret`);
    sh(`${arkdExec} ark send --to ${address} --amount 50000 --password secret`);
    await waitFor(async () => (await wallet.getBalance()).available >= 50_000, "faucet funds");
}, 300_000);

describe.runIf(MISMATCH_ONLY)("SM-10 B: client on the default emulator key vs our emulator", () => {
    it("refuses to fund: the client's own derivation does not match the solver's address", async () => {
        const inv = lncli("lnd-peer", `addinvoice --amt ${SEND_SATS}`);
        const before = (await wallet.getBalance()).available;
        let error: unknown;
        try {
            await requestLightningSend(wallet, httpTransport(SOLVER_URL), {
                invoice: decodeInvoice(String(inv.payment_request)),
            });
        } catch (e) {
            error = e;
        }
        console.log("SM-10 B result:", (error as Error)?.name, (error as Error)?.message);
        expect(error).toBeDefined();
        expect((await wallet.getBalance()).available).toBe(before);
    }, 300_000);
});

describe.skipIf(MISMATCH_ONLY)("real solver, both directions (regtest, fork arkd)", () => {
    it("send: the solver pays the payee's invoice and claims our lockup with P", async () => {
        const inv = lncli("lnd-peer", `addinvoice --amt ${SEND_SATS}`);
        const rHash = String(inv.r_hash);
        const before = (await wallet.getBalance()).available;

        const send = await requestLightningSend(wallet, httpTransport(SOLVER_URL), {
            invoice: decodeInvoice(String(inv.payment_request)),
            ...emu,
        });
        expect(send.fundAmount).toBeGreaterThanOrEqual(SEND_SATS);
        await wallet.send({ address: send.address, amount: send.fundAmount });

        // The payee was paid — through the solver's LND, by Lightning.
        await waitFor(
            async () => lncli("lnd-peer", `lookupinvoice ${rHash}`).state === "SETTLED",
            "the payee's invoice to settle",
        );
        // And the solver collected by claiming our lockup with the preimage it learned.
        const lockupScript = hex.encode(send.swapPkScript);
        await waitFor(
            async () =>
                (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos.some(
                    (v) => v.isSpent === true,
                ),
            "the solver's claim of the lockup",
        );
        const after = (await wallet.getBalance()).available;
        expect(before - after).toBe(send.fundAmount);
        console.log(
            `SEND ok: invoice ${SEND_SATS} settled; lockup ${send.fundAmount} claimed by solver`,
        );
    }, 600_000);

    it("send FAIL: the payee rejects, the solver refunds our lockup immediately (no timelock wait)", async () => {
        const inv = lncli("lnd-peer", `addinvoice --amt ${SEND_SATS}`);
        const rHash = String(inv.r_hash);
        const send = await requestLightningSend(wallet, httpTransport(SOLVER_URL), {
            invoice: decodeInvoice(String(inv.payment_request)),
            ...emu,
        });
        // The payee cancels after the quote: the solver's payment can only fail terminally.
        lncli("lnd-peer", `cancelinvoice ${rHash}`);
        const before = (await wallet.getBalance()).available;
        await wallet.send({ address: send.address, amount: send.fundAmount });
        const t0 = Date.now();

        const lockupScript = hex.encode(send.swapPkScript);
        await waitFor(
            async () =>
                (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos.some(
                    (v) => v.isSpent === true,
                ),
            "the solver's refund of the lockup",
        );
        const refundAddr = hex.encode(ArkAddress.decode(send.refundAddress).pkScript);
        await waitFor(
            async () =>
                (await indexer.getVtxos({ scripts: [refundAddr], spendableOnly: true })).vtxos.some(
                    (v) => v.value === send.fundAmount,
                ),
            "the refund to land on our refund address",
        );
        expect(lncli("lnd-peer", `lookupinvoice ${rHash}`).state).toBe("CANCELED");
        console.log(
            `SEND FAIL ok: lockup ${send.fundAmount} refunded in ${Math.round((Date.now() - t0) / 1000)}s (before ${before})`,
        );
    }, 600_000);

    it("receive: lnd-peer pays the solver's hold invoice, we claim with P, the solver settles", async () => {
        const before = (await wallet.getBalance()).available;
        const recv = await requestLightningReceive(wallet, httpTransport(SOLVER_URL), {
            amount: RECEIVE_SATS,
            amountSide: "to",
            decodeInvoice,
            ...emu,
        });
        const rec = swapSecretsToRecord(recv.secrets);
        const payHash = decodeInvoice(recv.invoice).paymentHash;

        const payment = spawn(
            "docker",
            ["exec", "lnd-peer", "lncli", "--network=regtest", "payinvoice", "--force", recv.invoice],
            { stdio: "ignore" },
        );
        onTestFinished(() => {
            payment.kill();
        });

        const lockupScript = hex.encode(recv.swapPkScript);
        await waitFor(
            async () => (await indexer.getVtxos({ scripts: [lockupScript] })).vtxos.length > 0,
            "the solver to fund the lockup (after the HTLC is held)",
        );
        // Not settled yet: the solver cannot settle before WE reveal P. (listpayments, not
        // trackpayment — trackpayment streams until terminal and would deadlock here.)
        const payStatus = () =>
            lncli("lnd-peer", `listpayments --include_incomplete --max_payments 50`).payments.find(
                (x: any) => x.payment_hash === payHash,
            )?.status;
        expect(payStatus()).toBe("IN_FLIGHT");

        const { vtxos } = await indexer.getVtxos({ scripts: [lockupScript] });
        const claim = await pushClaim(walletOperator(wallet), {
            contract: recv.script,
            receiver: await contractSigner(wallet, rec.signingDescriptor!),
            preimage: await preimageForSwapRecord(wallet, rec),
            vtxos: vtxos.map((v) => ({ ...v, recoverable: false })) as never,
            destinationPkScript: ArkAddress.decode(recv.payoutAddress).pkScript,
            expectedAmount: recv.expectedAmount,
        });
        expect(claim.amount).toBe(RECEIVE_SATS);

        await waitFor(
            async () => (await wallet.getBalance()).available >= before + RECEIVE_SATS,
            "the claimed sats to be spendable",
        );
        // The payer's payment completes only because the solver learned P from our claim.
        await waitFor(
            async () => payStatus() === "SUCCEEDED",
            "the payer's payment to succeed (solver settled the hold invoice)",
        );
        console.log(`RECEIVE ok: ${RECEIVE_SATS} claimed by us; payer's payment SUCCEEDED`);
    }, 600_000);
});
