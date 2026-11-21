/**
 * my-server SM-12 (not upstream): the HIGH-LEVEL client the bridge will use — createSwapClient with
 * ONLY our solver's card (localCards, registry off), a direct HTTP transport attested to the card's
 * discovery key (private network to our own solver), and our emulator key. The drive must do the
 * receive claim by itself. Any non-local fetch fails the test (no third party touched).
 */
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestOperatorProvider,
    SingleKey,
    Wallet,
} from "@arkade-os/sdk";
import { discover } from "@arkade-os/solver-discovery";
import { createSwapClient, InMemoryAssetSwapRepository } from "../../src";
import { httpTransport } from "../../src/protocol";

const OPERATOR_URL = "http://localhost:7070";
const ESPLORA_API_URL = "http://localhost:3000/api";
const SOLVER_URL = "http://localhost:8787";
const CARD = JSON.parse(readFileSync(process.env.SOLVER_CARD_PATH!, "utf8"));
const EMU = process.env.EMULATOR_PUBKEY_OVERRIDE!;

const sh = (c: string) =>
    execSync(c, { encoding: "utf8" })
        .split("\n")
        .filter((l) => !l.includes("WARN"))
        .join("\n")
        .trim();
const lncli = (node: string, args: string): any =>
    JSON.parse(sh(`docker exec ${node} lncli --network=regtest ${args}`));
const waitFor = (fn: () => Promise<boolean> | boolean, what: string, timeout = 180_000) =>
    vi.waitFor(
        async () => {
            if (!(await fn())) throw new Error(`timeout waiting for ${what}`);
        },
        { timeout, interval: 2_000 },
    );

const foreign: string[] = [];
const localOnly: typeof fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) {
        foreign.push(url);
        return Promise.reject(new Error(`foreign fetch blocked: ${url}`));
    }
    return fetch(input, init);
};

let wallet: Wallet;
let client: ReturnType<typeof createSwapClient>;

beforeAll(async () => {
    wallet = await Wallet.create({
        identity: SingleKey.fromRandomBytes(),
        arkProvider: new RestOperatorProvider(OPERATOR_URL),
        onchainProvider: new EsploraProvider(ESPLORA_API_URL, { forcePolling: true, pollingInterval: 2000 }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    const note = sh(`docker exec arkd arkd note --amount 60000`);
    sh(`docker exec arkd ark redeem-notes -n ${note} --password secret`);
    sh(`docker exec arkd ark send --to ${await wallet.getAddress()} --amount 50000 --password secret`);
    await waitFor(async () => (await wallet.getBalance()).available >= 50_000, "faucet");

    // Our card only: no registry followed ([]), the card's markets injected as a trusted snapshot.
    const { markets } = await discover({
        registries: [],
        localCards: [{ card: CARD, network: "regtest" }],
        network: "regtest",
        fetch: localOnly,
    } as never);
    expect(markets.length).toBeGreaterThan(0);
    client = createSwapClient({
        wallet,
        repository: new InMemoryAssetSwapRepository(),
        discovery: { registryUrl: null, snapshot: markets },
        transportFor: ({ solverPubkey }) => ({ ...httpTransport(SOLVER_URL), attestedResponder: solverPubkey }),
        emulatorPubkey: EMU,
        fetchImpl: localOnly,
    });
}, 300_000);

describe("high-level client on our solver only (regtest)", () => {
    it("pays an invoice through our solver", async () => {
        const inv = lncli("lnd-peer", "addinvoice --amt 5000");
        const result = await client.pay(String(inv.payment_request));
        expect(result.kind).toBe("swap");
        await waitFor(
            () => lncli("lnd-peer", `lookupinvoice ${inv.r_hash}`).state === "SETTLED",
            "the payee's invoice to settle",
        );
        console.log("HL SEND ok");
    }, 600_000);

    it("receives: the drive claims by itself once the payer pays", async () => {
        const before = (await wallet.getBalance()).available;
        const r = await client.receive({ amount: 7_000n, via: "lightning" });
        const bolt11 = (r.artifact as { bolt11: string }).bolt11;
        const payer = spawn("docker", ["exec", "lnd-peer", "lncli", "--network=regtest", "payinvoice", "--force", bolt11], {
            stdio: "ignore",
        });
        onTestFinished(() => {
            payer.kill();
        });
        await waitFor(async () => (await wallet.getBalance()).available >= before + 7_000, "the drive's claim");
        const hash = lncli("lnd-peer", `decodepayreq ${bolt11}`).payment_hash;
        await waitFor(
            () =>
                lncli("lnd-peer", "listpayments --include_incomplete --max_payments 100").payments.find(
                    (p: any) => p.payment_hash === hash,
                )?.status === "SUCCEEDED",
            "the payer's payment to succeed",
        );
        console.log("HL RECEIVE ok");
    }, 600_000);

    it("touched nothing outside localhost", () => {
        expect(foreign).toEqual([]);
    });
});
