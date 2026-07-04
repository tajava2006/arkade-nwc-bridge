# EXIT_PLAN.md — 일방탈출(unilateral exit) 탭 에픽

> **이 문서가 에픽의 단일 진실.** 세션이 끊겨도 이 문서만 읽고 이어서 작업한다.
> 하위작업 상태는 §5 체크박스로 추적하고, 상태 갱신 커밋은 에픽 브랜치에서 한다.
>
> 코드 인용 관례: `레포명 경로:라인` 텍스트로 쓴다 (예: `ts-sdk packages/ts-sdk/src/wallet/unroll.ts:157`).
> reference 클론들은 워크스페이스 한 단계 위 `../`에 있다 — 커밋되는 문서라 상대 링크 금지 (CLAUDE.md 참조).
> 라인 번호는 2026-07-04 시점 클론 기준; `update-refs.sh` 후 어긋날 수 있으니 심볼명으로 재탐색.

## 0. 목적

bridge의 두 번째 차별화 기능: **공식 아크 PWA 월렛도 지원하지 않는, GUI 일방탈출 경로.**
(첫 번째 차별화는 sub-dust LN 양방향.)

일방탈출 = ASP가 죽었거나 악의적이어도, 사전서명된 트랜잭션 리스트(증명)만으로
vtxo를 온체인까지 풀어내고(unroll), CSV 대기 후, 유저 단독 제어 주소로 빼내는(sweep) 것.

## 1. 요구사항 (운영자 지시, 확정)

1. **ASP/Boltz와 연결이 안 되어도 정상 동작해야 한다.** 일방탈출의 존재 이유.
2. 절차: vtxo의 역사를 leaf까지 풀고 → 오프체인 tx를 재현 브로드캐스트해 최종단까지 → CSV 대기 → 유저 단독 제어 plain 주소로 sweep.
3. 트리 tx는 전부 zero-fee로 설계되어 있으므로 브로드캐스트 시 **유저가 CPFP로 수수료를 낸다.** ASP가 아닌 유저 단독 키 필요.
4. CPFP 키/주소는 별도로 만들지 않는다. **bridge identity(nsec)의 hex 개인키에서 도출한 plain 탭루트 주소**를 쓴다 (추가 백업 불필요).
5. ts-sdk의 일방탈출 메소드는 ASP(indexer)를 호출해 증명을 가져오는 형태라 그대로는 못 쓴다 — **증명은 로컬 저장분에서 서빙**해야 한다.
6. vtxo 리스트에 변화가 생길 때마다 증명을 받아 로컬에 저장하는 상시 동기화가 필요하다.
7. 감지는 bridge가 트리거한 tx만이 아니라 **ASP가 살아있는 동안의 모든 vtxo 변화**를 대상으로 한다 (indexer subscription + 주기 reconcile). 단, *ASP가 전달해주지 않은 오프체인 수신*은 스코프 아웃.
8. 증명 저장은 공간 효율적으로 — vtxo들이 역사를 공유하는 구간은 중복 저장하지 않는다.
9. refresh 등으로 무효화된 증명 정리(GC) — nice to have (구현 비용이 싸서 포함).
10. **vtxo별 탈출 단계가 그림으로 표현**되어야 한다: tx1→tx2→…(leaf까지)→tx5→tx6→…(오프체인 재현 끝)→CSV 대기→sweep.

추가 확정 (2026-07-04 대화):
- degraded 부팅 모드(ASP 없이 뜨기)는 **선행 조건** 맞음.
- 스텁 인덱서 만드는 방향 맞음. 단일 브랜치(하위작업 #08)로 충분하다고 판단 — 클래스 하나 + 테스트 크기.
- esplora 의존 탈피(정확히는: 유저가 자기 mempool 인스턴스 URL을 지정할 수 있게) — **백로그**. #06에서 Config 필드로 설계해두면 코드는 사실상 공짜가 되고, 남는 건 문서화/설정 UI뿐.
- **/exit 실행은 vtxo 단위 강제** (2026-07-04, #02 실측 후 확정): 탈출 비용이 vtxo마다 극단적으로 다르므로(660 sats vtxo는 dust 이상이어도 온체인 tx 두세 번 fee로 소멸; 반대로 깊은 체인의 큰 vtxo도 feerate에 따라 손해) 일괄 "전체 탈출" 실행은 두지 않는다. vtxo별로 **브로드캐스트할 tx 개수와 총 vByte를 그림과 숫자로** 보여 유저가 "이건 빼는 게 더 손해"를 가늠하게 한다.

## 2. 코드 검증 결과 (설계 근거 — 재검증 불필요하도록 기록)

### 2.1 `Unroll.Session`은 재사용 가능, 단 스텁 인덱서 필요

`ts-sdk packages/ts-sdk/src/wallet/unroll.ts`:

- `Session` 생성자(L89-94)는 **public이고 `chain: ChainTx[]`를 직접 받는다** → ASP 없이 로컬 chain으로 세션 구성 가능. (`Session.create()`만 `indexer.getVtxoChain` 호출.)
- 그러나 `next()`(L111-190)가 **매 스텝 `this.indexer.getVirtualTxs([txid])`를 호출**(L157)해 PSBT를 가져온다. Session이 실제로 쓰는 indexer 메소드는 이것 하나 → **sqlite에서 PSBT를 서빙하는 `getVirtualTxs` 스텁 하나면 Session 통째로 재사용, 재구현 불필요.**
- 스텝 도출은 매번 esplora 상태에서 재계산: chain을 root(마지막 원소=commitment)→leaf 방향으로 훑어 "아직 온체인에 없는 가장 깊은 tx"를 다음 브로드캐스트 대상으로 정한다(L117-146). COMMITMENT는 항상 온체인이라 스킵. 멤풀에 있으면 WAIT 스텝. → **재시작 안전성이 공짜.** 로컬 상태머신 정밀 관리 불필요, 세션 재생성만으로 재개.
- finalize 규칙(L166-181): `TREE` tx는 PSBT input 0의 `tapKeySig`(라운드 때 완성된 musig2 집계서명)를 `finalScriptWitness`로; `ARK`/`CHECKPOINT`는 `tx.finalize()`. → **`getVirtualTxs`가 주는 PSBT에 서명이 완비되어 있다는 전제.** 이게 로컬에 저장할 "증명"의 실체.
- 브로드캐스트는 `bumper.bumpP2A(tx)`가 만든 `[parent, child]` 1P1C 패키지(L183-189).

### 2.2 chain 구조가 dedup을 공짜로 준다

`ts-sdk packages/ts-sdk/src/providers/indexer.ts`:

- `ChainTx = { txid, type, expiresAt, spends[] }` (L46-53). txid 기반 DAG →
  **PSBT를 txid PK 테이블에 저장하면 여러 vtxo가 공유하는 브랜치는 자동으로 1회 저장** (요구 8). fetch도 미보유 txid만 하면 되므로 네트워크 비용도 절약.
- `ChainTxType` enum(L20-26): `COMMITMENT | ARK | TREE | CHECKPOINT | UNSPECIFIED`.
- `getVirtualTxs(txids[], opts)` L521-544: `GET {indexer}/v1/indexer/virtualTx/{txids,}` — base64 PSBT 배열, **페이지네이션 있음**.
- `getVtxoChain(outpoint, opts)` L546-566: `GET {indexer}/v1/indexer/vtxo/{txid}/{vout}/chain` — **페이지네이션 있음**. 깊은 chain은 페이지 순회 필수.

### 2.3 ASP가 죽으면 현재 bridge는 부팅 자체가 실패

- `ts-sdk packages/ts-sdk/src/wallet/wallet.ts:539` — `Wallet.create`가 `arkProvider.getInfo()`를 await. esplora URL도 이 info의 network로 도출(`wallet.ts:567`, `config.esploraUrl`로 override 가능).
- bridge `src/index.ts` — 부팅 경로에서 `bootReady(account.privateKey)`를 그대로 await. 실패 시 프로세스가 못 뜬다.
- bridge는 InMemory repo(재부팅마다 indexer에서 재구축, `src/wallet.ts`) → ASP 죽은 상태에선 wallet 객체도, `wallet.getVtxos()`도 없음. **exit 경로는 Wallet 객체와 완전 분리**: 재료는 sqlite(vault) + identity(nsec) + 자체 esplora뿐이어야 한다.

### 2.4 CPFP와 sweep 목적지는 nsec 하나로 해결

`ts-sdk packages/ts-sdk/src/wallet/onchain.ts`:

- `OnchainWallet.create(identity, network, provider?)` L56-71: identity의 x-only pubkey로 `p2tr()` plain 주소 도출. bridge의 `SingleKey`가 곧 nsec(bridge `src/wallet.ts:16`) → 요구 4 그대로.
- `bumpP2A(parent)` L245-304: P2A 앵커(`51024e73`, zero-value, anyone-can-spend — `utils/anchor.ts:5-14`)를 input으로 v3 child를 만들고 자기 코인으로 fee를 대고 자기 주소로 잔돈. **앵커는 키가 필요 없고, 필요한 건 fee를 낼 온체인 UTXO** → nsec P2TR 주소에 미리 sats를 넣어두는 "CPFP 연료" UX가 필요.
- 패키지 브로드캐스트: `providers/onchain.ts:171-180` — 2개면 `broadcastPackage` → `POST {esplora}/txs/package`(L373). **zero-fee 부모는 단독 브로드캐스트가 원리적으로 불가하므로 이 엔드포인트가 단일 실패점** (§6 리스크, #01 스파이크).
- mainnet 기본 esplora는 `https://mempool.arkade.sh/api` (Ark Labs 운영, `providers/onchain.ts:14-20`) — ASP 진영과 상관관계 있는 인프라라 제3자 폴백 필수.

### 2.5 sweep은 로컬판 재작성 (SDK 함수가 Wallet 객체 의존)

`ts-sdk packages/ts-sdk/src/wallet/unroll.ts:239-332` `prepareUnrollTransaction`:

- `wallet.getVtxos({withUnrolled})`, `wallet.onchainProvider`, `wallet.identity`, `wallet.network` 사용 → degraded 모드에선 못 씀. **~90줄 어댑테이션으로 로컬판 작성** (하위작업 #10). 필요한 재료는 전부 로컬에 있음:
  - vtxo의 `tapTree` (저장해둔 `ExtendedVirtualCoin`에서) → `VtxoScript.decode(tapTree).exitPaths()`로 CSV exit path, `findLeaf`로 witness.
  - 컨펌 높이/시각 → esplora `getTxStatus`.
  - 서명 → nsec `SingleKey`.
- CSV 충족 판정 로직 `availableExitPath`(L369-388)는 **module-private (export 안 됨)** → 소형 헬퍼로 복제 (blocks/time 두 타입 처리). UI 카운트다운에도 재사용.
- 여러 vtxo 배치 입력 가능(입력별 CSV sequence) — sweep fee를 나눠 내므로 **sub-dust vtxo도 배치에 실려 나갈 수 있음**. 최소 출력 `DUST_AMOUNT = 546` (`wallet/utils.ts:17`).
- `ExtendedVirtualCoin` 영속화: `repositories/serialization.ts`에 `serializeVtxo`/`deserializeVtxo`(L51, L79) 있음. **패키지 루트에서 export되는지 확인 필요** — 아니면 필요 필드만 자체 직렬화 (#03에서 판정).

### 2.6 vtxo 변화 감지 훅

- `ts-sdk packages/ts-sdk/src/wallet/wallet.ts:1124` `notifyIncomingFunds(callback)` — indexer subscription 기반, 주석상 순수 outgoing 활동에도 발화. → 요구 7의 주 감지 경로.
- 안전망: 주기 폴링으로 `wallet.getVtxos()` ↔ vault diff (놓친 이벤트 reconcile).
- 스코프 아웃 그대로: ASP가 안 알려준 수신은 못 잡는다 (수용됨).

### 2.7 기타 확정 사실

- 만료 = 탈출 데드라인: chain의 `expiresAt` / vtxo `expiresAt` 이후 ASP가 배치를 sweep하면 증명 무효. 만료 임박 exit은 ASP sweep과 race (분석: 워크스페이스 문서 UNROLL_TREE_MECHANICS.md).
- 여러 vtxo 동시 탈출: 공유 브랜치는 Session이 온체인/멤풀 상태를 보고 스킵/WAIT 처리(2.1) → 순차 실행이면 자연 dedup.
- 비용 견적은 오프라인 계산 가능: 저장 PSBT의 vsize + child(~111 vB) × feerate 합 + sweep fee. exit-all은 tx 합집합 기준(공유 브랜치 1회 계상).
- `bun test`는 `*.test.ts`만 집전 → 네트워크 치는 스파이크는 `test/spike/*.spike.ts`로 격리.

## 3. 아키텍처

```
┌─ 평시 (ASP alive) ────────────────────────────────────────────┐
│ ProofSync ─ 트리거: boot reconcile / notifyIncomingFunds /    │
│             bridge발 send·settle 후 / 주기 폴링               │
│           → getVtxoChain(페이지) + getVirtualTxs(미보유 txid) │
│           → Vault(sqlite): exit_proof_txs ⊕ exit_vtxos → GC   │
│ 대시보드 exit-readiness 지표 (N/M 증명완비 · 마지막 동기화)   │
└───────────────────────────────────────────────────────────────┘
┌─ 비상시 (ASP dead → degraded 부팅) ───────────────────────────┐
│ ExitEngine ─ Vault chain → Unroll.Session(스텁 indexer,       │
│              bumper=OnchainWallet(nsec P2TR), 자체 esplora)   │
│            → 스텝별 1P1C 브로드캐스트 → CSV 대기              │
│            → 로컬판 sweep → nsec P2TR (오버라이드 가능)       │
│ /exit 탭 ─ 항상 접근 가능 (평시엔 상태/리허설 뷰)             │
└───────────────────────────────────────────────────────────────┘
```

컴포넌트: **Vault**(저장, #03) · **ProofSync**(평시 데몬, #04-05) · **Degraded boot**(#06-07) ·
**ExitEngine**(#08-11) · **/exit 탭**(#12-14).

## 4. 작업 프로세스 (에픽 브랜치 + 워크트리)

- 에픽 브랜치: `epic/unilateral-exit` (main에서 분기).
- 하위작업 브랜치: `exit/NN-이름` (에픽에서 분기) → 작업 → 운영자 리뷰 → **에픽으로 머지**.
  전부 끝나면 에픽 → main 머지.
- **모든 브랜치는 워크트리로 격리.** 워크트리는 레포 루트 `.worktrees/`에 모은다 (gitignore 처리됨).
  main 체크아웃은 항상 `main`에 머문다(운영 코드 스왑 방지) — **에픽 브랜치도 상주 워크트리로**:

```bash
# 최초 1회: 에픽 브랜치 + 상주 워크트리
git worktree add .worktrees/epic -b epic/unilateral-exit main

# 하위작업 시작
git worktree add .worktrees/exit-03-vault-schema -b exit/03-vault-schema epic/unilateral-exit
cd .worktrees/exit-03-vault-schema && bun install   # node_modules는 워크트리별

# 완료 후 (리뷰 통과 뒤) — 머지는 에픽 워크트리에서
cd ../epic && git merge --no-ff exit/03-vault-schema
# EXIT_PLAN.md §5 체크박스 갱신 커밋도 여기서
git worktree remove ../exit-03-vault-schema && git branch -d exit/03-vault-schema
```

운영 주의:
- 커밋은 하위작업 브랜치 안에서 자유롭게 하되, **에픽으로의 머지는 운영자 리뷰 후에만**.
- 워크트리에서 `bun run dev` 하면 포트 4282가 운영 인스턴스와 충돌 → 운영 중지하거나 워크트리 `data/config.json`에 다른 포트. 워크트리 `data/`는 각자 빈 상태(가짜 계정으로 셋업)라 **운영 sqlite를 절대 가리키지 않는다** — 격리가 곧 안전.
- db 마이그레이션 버전(v10, v11)은 에픽 작업 중 main에 다른 마이그레이션이 랜딩하면 에픽→main 머지 전에 재번호 (append-only 규칙).

## 5. 하위작업

상태: ⬜ 대기 / 🔧 진행 중 / ✅ 에픽 머지됨. 크기: S(반나절 이하) / M(하루 내외) / L(수일).

### Phase 0 — 검증 스파이크 (여기서 죽으면 플랜 수정이 제일 싸다)

- ✅ **#01 `exit/01-spike-package-broadcast`** (S)
  `POST {esplora}/txs/package` 실지원 검증: `mempool.arkade.sh/api`, `mempool.space/api` probe(유효하지 않은 패키지로 404 vs 파싱에러 판별). 실제 1P1C 성공 확인은 docker 미가용으로 #15 드릴로 이월(스크립트 `--live` 모드로 준비).
  산출: `test/spike/package_broadcast.spike.ts` + §7 결정 기록(esplora 우선순위 리스트 확정, 전멸 시 bitcoind `submitpackage` 폴백을 #09 스코프에 추가).
  DoD: 결정 기록 작성됨.

- ✅ **#02 `exit/02-spike-offline-finalize`** (M)
  핵심 디리스킹. 현재 mainnet vtxo로 chain+virtualTxs를 받아 로컬 JSON으로 덤프 → 인라인 스텁으로 `Session` 구성 → **`do()` 호출 없이** `next()` 드라이런: TREE `tapKeySig` finalize, ARK/CHECKPOINT `finalize()` 성공 확인. 페이지네이션 동작 확인. 증명 용량 실측. 타이밍 프로브: settle/send 직후 `getVirtualTxs`가 완비 PSBT를 주기까지 지연 측정 → ProofSync 백오프 파라미터.
  산출: `test/spike/offline_finalize.spike.ts` + §7 기록(용량 표, 타이밍, 라운드산/preconfirmed산 vtxo 각각 통과 여부). 덤프는 로컬 보관(mainnet txid가 지갑 역사를 드러내므로 **fixture 커밋 금지** — 커밋용 fixture는 #15 regtest에서 채취).
  DoD: vtxo 2종(라운드 산출, preconfirmed) 드라이런 통과.

### Phase 1 — Proof Vault + ProofSync

- ⬜ **#03 `exit/03-vault-schema`** (M)
  마이그레이션 **v10**: `exit_proof_txs(txid PK, type, psbt_base64, first_seen_at)` + `exit_vtxos(txid, vout, PK(txid,vout), vtxo_json, chain_json, expires_at, synced_at)`.
  `src/exit/vault.ts`: upsertProofTx / upsertVtxoChain / getChain / getProofTxs / listVtxos / missingTxids / gc(liveOutpoints) / stats(readiness 카운트+바이트). vtxo_json 직렬화: SDK `serializeVtxo` export 여부 확인, 안 되면 필요 필드(outpoint, value, script, tapTree, createdAt, expiresAt)만 자체 직렬화.
  DoD: 인메모리 sqlite 단위 테스트 + typecheck.

- ⬜ **#04 `exit/04-proof-sync-engine`** (M)
  `src/exit/proof_sync.ts`: `syncOnce(currentVtxos)` — vault와 diff → 신규/변경 outpoint별 chain 페이지 순회 → 미보유 txid만 `getVirtualTxs` 배치 fetch → 트랜잭션 저장 → GC. 백오프 재시도(#02 결과 반영). 순수 로직 — index.ts 배선 없음.
  DoD: fake indexer로 단위 테스트(페이지네이션, 부분 실패, dedup fetch) + 라이브 지갑 1회 수동 실행.

- ⬜ **#05 `exit/05-proof-sync-wiring`** (M)
  index.ts 배선: boot reconcile + `notifyIncomingFunds` 훅 + bridge발 자금이동 후 트리거 + 주기 폴링(~10분) + shutdown teardown. 대시보드 exit-readiness 프래그먼트("vtxo N/M 증명완비 · 마지막 동기화 X분 전 · Y KB") + SSE 이벤트 `exit-readiness` (기존 SseHub/data-슬롯 패턴).
  DoD: mainnet에서 수신/송금/refresh 각각 후 vault 추종 + 대시보드 라이브 갱신 확인.

### Phase 2 — ASP 없이 부팅

- ⬜ **#06 `exit/06-esplora-config`** (S)
  defaults.ts에 exit용 esplora 우선순위 리스트(#01 결정) + Config 필드(→ `data/config.json` override로 **백로그 "유저 자기 mempool" 코드가 사실상 완성됨**). `src/exit/esplora.ts`: 리스트 기반 EsploraProvider 팩토리(첫 정상 응답 인스턴스 선택 수준의 단순 failover). 같은 URL을 `Wallet.create({esploraUrl})`에도 전달(평시/비상 뷰 일치).
  DoD: typecheck + mainnet 부팅 정상.

- ⬜ **#07 `exit/07-degraded-boot`** (M)
  index.ts: `bootReady` 실패 시 크래시 대신 `mode:'degraded'` AppState(identity + esplora + OnchainWallet + db) + 주기 재시도로 ready 자동 승격(SSE 공지). server.ts: setup/ready 이분법 → 3-모드 가드, degraded에서 `/exit`(+ CPFP 펀딩 뷰) 허용, 나머지는 "ASP 연결 불가 — 일방탈출은 가능" 안내.
  DoD: arkd 내리고 재시작 → degraded 부팅 + /exit 접근, arkd 올리면 재시작 없이 ready 승격.

### Phase 3 — Exit 엔진

- ⬜ **#08 `exit/08-stub-indexer`** (S) — 단일 브랜치로 충분
  `src/exit/vault_indexer.ts`: vault에서 `getVirtualTxs` 서빙(+`getVtxoChain`도 vault에서), 나머지 메소드는 "not available offline" throw. IndexerProvider 인터페이스 준수.
  DoD: fixture 단위 테스트 (#02 덤프를 로컬로 사용, 커밋 fixture는 #15에서 교체).

- ⬜ **#09 `exit/09-engine-core`** (L)
  마이그레이션 **v11**: `exit_ops(txid, vout, PK(txid,vout), state: unrolling|waiting|sweepable|swept|failed, sweep_txid, dest_address, error, created_at, updated_at)`.
  `src/exit/engine.ts`: `startExit(outpoints[])` → vault chain으로 `new Unroll.Session(...)`(스텁 indexer + 자체 esplora + OnchainWallet bumper), 순차 실행, 스텝 이벤트 SSE 중계, op 상태 전이, **부팅 시 미완료 op 재개**(degraded/ready 공통 — Session 재생성으로 충분, §2.1). CSV 충족 판정 헬퍼(`availableExitPath` 복제, blocks/time 겸용).
  (#01 결과에 따라 bitcoind `submitpackage` 폴백 broadcaster 포함 여부 결정.)
  DoD: mocked esplora로 상태 전이 단위 테스트.

- ⬜ **#10 `exit/10-engine-sweep`** (M)
  `src/exit/sweep.ts`: `prepareUnrollTransaction` 로컬판 — 저장 tapTree의 exitPaths + esplora 컨펌 정보로 CSV 판정, 여러 vtxo 배치 입력, 목적지 default = nsec P2TR(오버라이드 입력 허용), `DUST_AMOUNT`(546) 가드, feerate floor `MIN_FEE_RATE`.
  DoD: fixture tapTree 단위 테스트 (실브로드캐스트 검증은 #15).

- ⬜ **#11 `exit/11-engine-estimator`** (M)
  `src/exit/estimate.ts`: vtxo별 비용 = Σ(브랜치 tx vsize + child ~111vB)×feerate + sweep fee 분담. exit-all은 tx 합집합(공유 브랜치 1회 계상). CPFP 지갑 잔액 vs 견적 부족분. sub-dust "비용 > 가치" 판정.
  DoD: 단위 테스트. #09와 병렬 가능(입력은 vault만).

### Phase 4 — /exit 탭 UI

- ⬜ **#12 `exit/12-ui-tab`** (M)
  nav 탭 + `/exit` 라우트 + vtxo 테이블: 금액 · **만료 카운트다운(최우선 표시 — 지나면 탈출 불가)** · 증명 상태 · **탈출 견적 = 브로드캐스트할 tx/패키지 개수 + 총 vByte + 현재 feerate 기준 예상 sats + 가치 대비 %** · **경제성 판정("빼는 게 더 손해" 명시 — sub-dust만이 아니라 660 sats류 저액도, 깊은 체인의 고액도 feerate 따라 해당)**. 서버 렌더 우선(라이브는 #13).
  DoD: ready/degraded 양쪽에서 렌더.

- ⬜ **#13 `exit/13-ui-stepper`** (M)
  요구 10의 그림. vtxo별 수직 스테퍼: commitment(항상 온체인)→TREE…→CHECKPOINT/ARK→vtxo tx, 단계별 ✅컨펌/🕐멤풀/⬜대기 + **단계별 vsize 표기(합계가 #12 견적과 일치)** → `WAIT: CSV n/총` 카운트다운 → `SWEEP → 주소`. SSE 라이브 갱신(기존 data-슬롯 패턴). 이 그림이 "몇 번을 브로드캐스트해야 하는지"의 시각 답이다.
  DoD: 진행 중 exit이 실시간으로 단계 이동.

- ⬜ **#14 `exit/14-ui-controls`** (M)
  실행 컨트롤: **실행은 반드시 vtxo 단위** — vtxo별 [탈출 시작]/[Sweep]만 두고 일괄 [전체 탈출] 버튼은 두지 않는다(§1 추가 확정: 경제성이 vtxo마다 달라 개별 판단 강제). 확인 다이얼로그(그 vtxo의 tx 개수·총 vB·예상 비용·비가역 고지) + 재개 상태 표시. Sweep은 unroll 완료된 vtxo들을 한 tx 배치 입력으로 묶는 것 유지(수수료 분담 — 탈출 실행 결정과 무관한 절약). CPFP 펀딩 패널: nsec P2TR 주소 + QR(기존 qr.ts) + 잔액 + 견적 대비 부족 경고 — degraded에서도 동작.
  DoD: regtest에서 버튼만으로 exit 1건 완주 가능한 상태.

### Phase 5 — 드릴 + 문서

- ⬜ **#15 `exit/15-drill-regtest`** (L)
  arkade-regtest 스택(ts-sdk repo `regtest/`)에 bridge를 붙여 풀 드릴: 수신 → vault 동기화 확인 → **arkd kill** → degraded 부팅 → 탭에서 전체 탈출 → 블록 채굴로 CSV 경과 → sweep 완주. 드릴 런북 스크립트화. 여기서 나오는 수정은 이 브랜치 또는 소형 후속 브랜치로. **커밋용 test fixture를 regtest에서 채취해 #08/#10 테스트에 주입** (mainnet 덤프 대체).
  DoD: 런북 재현 성공. 이게 이 기능의 존재 증명.

- ⬜ **#16 `exit/16-design-doc`** (S)
  `EXIT_DESIGN.md` (영어, SEND/RECEIVE_DESIGN 관례) — 왜 Session 재사용인지, 왜 nsec P2TR인지, vault 스키마 근거, 스코프 아웃, 운영 절차(비상 시 순서). CLAUDE.md 갱신(프로젝트 shape + when-to-read-what). 이 문서(EXIT_PLAN.md) 상태 최종화.
  DoD: 문서 머지.

에픽 완료 = #01-#16 전부 ✅ → `epic/unilateral-exit` → `main` 머지 (마이그레이션 번호 재확인 포함).

## 6. 리스크

- **패키지 릴레이 = 단일 실패점.** zero-fee 부모는 단독 브로드캐스트 불가. `/txs/package` 미지원이면 기능 무의미 → #01이 최우선. mainnet 기본값(mempool.arkade.sh)은 Ark Labs 운영이라 제3자 폴백 필수, 최후엔 로컬 bitcoind `submitpackage`.
- **증명 신선도 = 탈출 가능성.** 마지막 동기화 이후 ASP가 죽으면 그 사이 vtxo는 못 나간다. exit-readiness를 대시보드 1급 시민으로 두는 이유.
- **만료 race.** expiry 임박 vtxo는 unroll해도 ASP sweep과 경쟁. UI는 카운트다운으로 "여유 있을 때 시작"을 유도하는 것까지가 인프라 몫.
- **SDK 업그레이드 취약면.** `getVirtualTxs` 포맷/finalize 규칙 변경 시 vault의 옛 PSBT와 어긋날 수 있음 → #02 스파이크 스크립트를 `update-refs.sh` 후 회귀 체크로 상시 활용.
- **fixture 프라이버시.** mainnet 덤프(txid·PSBT)는 지갑 역사 노출 → 커밋 금지, regtest 채취분만 커밋.
- **체인 깊이 = 탈출 비용 (#02 실측).** preconfirmed 홉이 쌓일수록 unroll 패키지 수가 선형 증가(운영 지갑 실측: 53홉 → ~32,000vB). settle이 체인을 리셋하므로 "주기적 refresh는 탈출 보험료"라는 관계를 UI(#11/#12)가 표면화해야 하고, griefing 이슈로 꺼둔 consolidate-all Refresh의 재활성 검토(arkd #1136 해소 후)와도 엮인다.

## 7. 결정 기록 (스파이크가 채움)

- [x] #01 (2026-07-04): **esplora 우선순위 = `["https://mempool.space/api", "https://mempool.arkade.sh/api"]`** — 프로브 결과 둘 다 `POST /txs/package` 지원, bitcoind `submitpackage` RPC 직결 확인(`[]` → RPC -8 count 에러 릴레이; garbage는 mempool.space가 자체 검증 레이어에서 반려, arkade는 RPC -4 릴레이). 제3자(mempool.space) 1순위 — ASP 적대 시나리오에서 Ark 생태계 독립 인프라 우선, 폴링(5초 1회)은 rate limit 여유. **bitcoind 폴백 = 당장 불필요.** regtest 라이브 1P1C는 이 머신 docker 미가용으로 **#15 드릴로 이월**(스크립트 `--live <base> <parentHex> <childHex>` 모드 준비됨). 정책 리스크 추가 확인: arkd 트리 tx는 **v3(TRUC) + 제로값 P2A**로 생성(`arkd pkg/ark-lib/tree/builder.go:222`의 `psbt.New(..., 3, 0, ...)`, `txutils/anchor.go:13-22`), SDK CPFP child도 v3(`ts-sdk src/wallet/onchain.ts:249`) → TRUC/ephemeral-dust 정합 모양.
- [x] #02 (2026-07-04, **운영 지갑 mainnet 실검증 통과**): 운영 vtxo 1개(830,863 sats, preconfirmed)의 chain을 `--address` 모드로 덤프 → **107/107 tx 오프라인 finalize 성공 + 전부 P2A 앵커 확인 + 실제 `Unroll.Session.next()`가 스텁 indexer 위에서 finalize된 UNROLL 패키지 생성**. DoD의 "2종" 충족: chain에 TREE 3(=tapKeySig 경로) + ARK 49/CHECKPOINT 55(=finalize() 경로) 모두 포함. 실측: chain refs 119 → unique 107(단일 vtxo 안에서도 DAG dedup 발생), 증명 106.1 KB(base64), ARK ~217vB·CHECKPOINT ~174vB. **핵심 함의 — 체인 깊이 = 탈출 비용**: 이 vtxo는 refresh 없이 zap을 53홉 쌓은 상태라 unroll에 ~107패키지 ≈ 총 ~32,000vB → 1 sat/vB에서도 ~32k sats(가치의 ~4%), 10 sat/vB면 ~39%. settle(자동갱신) 직후엔 chain이 TREE-leaf 수준(3~5 tx)으로 리셋되어 비용이 급감 — #11 견적기와 /exit UI가 이 관계를 반드시 표면화할 것(refresh 비활성 트레이드오프). 스파이크 모드 4종: `--db`(nsec→스크립트 도출)/`--address`(주소만; 증명은 두 모드 다 공개 인덱서에서)/`--replay`(저장 덤프만으로 오프라인 재검증 — SDK 범프 후 회귀용)/`--watch`(증명 가용 지연 측정; 미실측 — #04는 generic backoff로 흡수). 부수 확인: ① `ReadonlyWallet.getVtxos`는 repo-first라 fresh InMemory repo에선 빈 결과 — vtxo 목록은 `RestIndexerProvider.getVtxos({scripts, spendableOnly∪recoverableOnly})` 직접 조회(#04 반영). ② bun 1.3 콜드 캐시에서 폴리필 없이 SDK import 시 1회성 크래시 — `src/polyfills` 선-import 관례를 #07 degraded 경로에도 유지. 덤프는 워크트리 `data/exit-spike/`(gitignore) 전용 — 커밋 금지.
- [ ] #03: SDK `serializeVtxo` 패키지 export 여부 = (미정)

## 8. 백로그 (에픽 스코프 밖)

- **유저 지정 esplora / 자가 mempool 인스턴스**: #06의 Config 필드 + `data/config.json` override로 코드는 사실상 완료. 남는 것 = 문서화 + settings 페이지 UI. (운영자 확인: "인스턴스 띄우는 게 일이지 코드는 간단" — 나중.)
- **mainnet 소액 드릴**: #15 통과 후 결정 (CPFP 비용 실화폐).
- **boarding UTXO CSV reclaim**: exit 탭 자연 확장 (boarding 스크립트의 CSV timeout 경로 — RECEIVE_DESIGN 참조).
- **esplora failover 고도화**: #06은 단순 선택까지만; 스텝 중간 전환 등은 필요해지면.
