# ATOMIC_SUBDUST_PLAN.md — 아토믹 sub-dust LN swap 에픽

> **이 문서가 에픽의 단일 진실.** 세션이 끊겨도 이 문서만 읽고 이어서 작업한다.
> 하위작업 상태는 §6 체크박스로 추적하고, 상태 갱신 커밋은 에픽 브랜치에서 한다.
>
> 세션 재개 절차: ① 이 문서 통독 → ② §6에서 다음 ⬜ 하위작업 확인 → ③ §8 결정 기록에
> 선행 스파이크 결과가 채워졌는지 확인 → ④ 워크트리 파서 작업. §2는 재검증 불필요(코드 인용 완비).
>
> 코드 인용 관례: `레포명 경로:라인` 텍스트로 쓴다 (예: `arkd internal/core/application/service.go:806`).
> reference 클론들은 워크스페이스 한 단계 위 `../`에 있다 — 커밋되는 문서라 상대 링크 금지.
> 라인 번호는 2026-07-14 시점 클론 기준 (arkd v0.9.10 checkout). bump 후 어긋나면 심볼명으로 재탐색.

## 0. 목적

**sub-dust 금액(<330 sats)의 LN swap을 양방향 모두 아토믹하게** — 현행 plain 경로(아토믹 포기,
`SUBDUST_LN_PATCH.md`)를 완전히 대체한다. 제품 카피가 "21 sats zap 가능"에서
**"21 sats zap, 아토믹, 신뢰 불필요"**로 승격된다. ARK 진영 어디에도 없는 구성 (킬러기능).

**핵심 아이디어 (운영자 고안, 2026-07-14):** sub-dust가 안 되는 이유는 *아웃풋*이 dust 미만이라
온체인 청구권이 소멸하기 때문. 그렇다면 **금액을 아웃풋으로 만들지 말고, 사전서명된 두 상태 간
델타로 접는다**: 유저 U + boltz B를 하나의 공유 아웃풋(U+B ≥ dust)에 넣고,
- preimage 공개 시: {유저 U−a, boltz B+a} (성공 스플릿)
- 타임아웃 시: {유저 U, boltz B} (환불 스플릿)
모든 아웃풋이 dust 이상이므로 일방탈출·sweep 전부 성립. a(결제 금액)가 sub-dust여도 무관.
본질은 단일 결제 전용 미니 페이먼트 채널. LN조차 sub-dust HTLC는 trimmed(비보장)인데 이 구성은
조건부가 하나뿐이라 밸런스에 접을 수 있어 in-flight까지 보장된다.

## 1. 요구사항 (운영자 지시, 2026-07-14 확정)

1. **양방향 아토믹.** 보내기(ARK→LN) = 유저가 델타 지불, 받기(LN→ARK) = boltz가 델타 지불 +
   hold invoice 복귀 (plain 경로가 버렸던 preimage 댄스가 이 구성에선 다시 가능해짐).
2. **plain 경로(비아토믹)는 폴백으로 남기지 않고 완전 제거.** `/v2/subdust/receive`·`/send`·
   `/address` + `SubdustSend` 모델 + bridge의 plain 분기 전부. 유동성 조건 미달이면 명시적
   에러로 무조건 중지 (에러 코드로 상황 식별 가능하게).
3. **자격조건 (uniform rule):** 양쪽 각자 **단일 vtxo로 amount ≥ dust + a**를 만족하는 spendable
   vtxo가 하나 이상. (근거: 지불측은 a 차감 후에도 ≥ dust여야 sweep 가능. 수취측은 원리상
   ≥ dust면 충분하지만 v1은 대칭 규칙으로 단순화 — 완화는 백로그.) 한쪽이라도 없으면 중지.
   v1은 측당 인풋 1개 (multi-input 조합은 백로그).
4. **사전서명 상태는 DB 영속.** 인메모리 금지. boltz는 pg 테이블, bridge는 sqlite 마이그레이션.
5. **T(환불 타임락)는 짧게.** LN 결제는 정상적으로 수 초 내 종결 — T를 짧게 잡아 collateral
   락업과 batch expiry 리스크를 동시에 관리.
6. **known-risk 수용 (기록만, v1 무대응):**
   - 상대방 unroll 감시(워처) 없음 — "그런 일 벌어지면 잃는다 치고".
   - batch expiry 제약은 인풋 선택 시 expiry 필터 + 짧은 T로만 관리.
   - 그리핑(오픈 후 방치로 collateral 락) 방어 없음 — 심해지면 그때 rate-limit.

## 2. 코드 검증 결과 (arkd v0.9.10, 2026-07-14 세션 — 재검증 불필요하도록 기록)

이 에픽의 성립 근거. **arkd 패치 불필요** — 필요한 프리미티브가 전부 현행 코드에 있다.

### 2.1 멀티파티 펀딩 가능

`SubmitOffchainTx`는 인풋별로 독립적인 vtxo 스크립트/체크포인트를 검증할 뿐 소유자 동일성을
요구하지 않는다 (`arkd internal/core/application/service.go:579-883` 인풋 루프). ark tx 인풋마다
non-server 서명 1개 이상만 요구 (`service.go:885-921`). → 유저 vtxo + boltz vtxo 2-input 펀딩 OK.
아웃풋 스크립트는 생성 시점엔 검사 안 함(스펜딩 때 taptree 공개 방식) — 커스텀 공유 아웃풋 생성 자유.

### 2.2 필요한 closure 전부 존재 + 협력 경로 허용 목록

- 협력(오프체인) 스펜딩 허용 closure: `MultisigClosure` | `CLTVMultisigClosure` |
  `ConditionMultisigClosure` (`service.go:806-818`). CLTV는 제출 시점 블록시간 검사 (`service.go:820-851`).
- exit closure 유효성: `CSVMultisigClosure` | `ConditionCSVMultisigClosure`, CSV ≥ 서버 최소 딜레이
  (`arkd pkg/ark-lib/script/vtxo_script.go:135-162`). 협력 경로(forfeit closure)엔 signer 키 필수
  (`vtxo_script.go:101-133`).
- hashlock condition은 VHTLC가 프로덕션 실증 (ts-sdk `packages/ts-sdk/src/script/vhtlc.ts`).

### 2.3 사전서명 성립 (이 설계의 심장)

- txid는 witness 제외 해시 → 서명 전 확정 (LN 채널 펀딩과 동일 원리).
- `BuildTxs`는 (인풋, 아웃풋, checkpointTapscript)만으로 완전 결정적
  (`arkd pkg/ark-lib/offchain/tx.go:31-73`). checkpointTapscript는 서버 설정(GetInfo로 취득).
- checkpoint 아웃풋 스크립트 = `{server unroll CSV, 원본 vtxo의 collaborative closure 그대로}`
  (`offchain/tx.go:183-185`) → **2-of-2 closure가 checkpoint 아웃풋에 상속**되므로 사전서명 우회 불가.
- `FinalizeOffchainTx`는 서명만 암호학적으로 검증, 제출자 신원 무관 (`service.go:1104-1164`,
  특히 `service.go:1144-1149`) → **상대방 오프라인이어도 사전서명 세트만으로 완결 가능.**
- 금액 보존 강제: inputAmount == outputAmount (`offchain/tx.go:63-65`) → 스플릿 변조 불가.

### 2.4 dust 규칙 (스플릿 설계 제약)

- 오프체인 아웃풋: non-OP_RETURN은 ≥ dust 강제 (`service.go:4577-4579`). sub-dust는 OP_RETURN
  소각형만 허용 (`service.go:4520-4541`) — 우리 스플릿은 전부 ≥ dust라 무관.
- sub-dust/swept vtxo는 인풋으로 거부 `VTXO_RECOVERABLE` (`service.go:681-685`) → 자격조건 §1.3의 근거.

### 2.5 남은 실증 항목 (Phase 0 스파이크가 확인)

- arkd가 5-leaf 커스텀 스크립트의 공유 vtxo 생성→스펜딩 전 과정을 실제로 수락하는지 (regtest).
- 클라이언트(ts-sdk 조립)가 만든 checkpoint/ark tx가 서버 재구성(`service.go:946`)과 바이트 일치하는지.
- unroll 후 사전서명 온체인 child의 anchor/CPFP 브로드캐스트.

## 3. 프로토콜 설계

### 3.1 공유 아웃풋 스크립트 (5-leaf)

역할: 방향 불문 **claimer** = preimage 공개로 델타를 가져가는 쪽 (보내기=boltz, 받기=유저),
**refunder** = 반대쪽. H = 인보이스 payment hash, a = 결제 금액.

| # | leaf | closure | 용도 |
|---|------|---------|------|
| 1 | claim | `ConditionMultisig{hashlock(H), [user, boltz, server]}` | 협력 성공 경로 |
| 2 | refund | `CLTVMultisig{T, [user, boltz, server]}` | 협력 환불 (T 이후) |
| 3 | cancel | `Multisig{[user, boltz, server]}` | 협력 즉시 취소 (라이브 cosign만 — 사전서명 안 함) |
| 4 | uclaim | `ConditionCSVMultisig{hashlock(H), d₁, [user, boltz]}` | 일방 성공 (unroll 후) |
| 5 | urefund | `CSVMultisig{d₂, [user, boltz]}` | 일방 환불 (unroll 후) |

- **모든 leaf가 user+boltz 2-of-2** — 스크립트는 "누가"만 통제하고 "얼마씩"은 통제 못 하므로,
  금액 스플릿의 강제 수단은 오직 상호 사전서명. 단독 키 leaf는 하나라도 있으면 전액 탈취 가능.
- **refund에 CLTV(T) 필수** — VHTLC의 무타임락 refund는 "receiver가 라이브 cosign 안 해주면 안 됨"
  으로 보호되지만 우리는 refund를 **사전서명**하므로 그 보호가 없다. T 없으면 지불측이 LN in-flight
  중에 환불 가능 → 깨짐. cancel leaf(3)는 라이브 cosign 전용이라 무타임락이어도 안전 —
  LN 즉시 실패 시 T 대기 없이 즉시 unwind하는 UX용.
- d₁ < d₂ (계단식): unroll 레이스에서 claim이 refund를 항상 선행. VHTLC의
  unilateralClaimDelay < unilateralRefundDelay 관례 그대로 (ts-sdk vhtlc.ts).
- 스펜트 vtxo unroll 사기엔 표준 대응(협력 경로엔 CSV가 없어 checkpoint tx가 exit보다 선행 가능,
  `UNROLL_TREE_MECHANICS.md`) — 단 v1은 워처 없음(§1.6 수용).

### 3.2 트랜잭션 세트 (전부 결정적, 펀딩 제출 전 확정)

```
funding ark tx:  [user vtxo U, boltz vtxo B] → [shared (U+B, 5-leaf script), anchor]
                 (체인지 없음 — vtxo 통째로 넣고 스플릿이 체인지 역할. §1.3 자격조건의 이유)

오프체인 성공:   checkpoint_c(shared→ckpt) + arkTx_c(ckpt → [claimer측+a, refunder측−a... 방향별 스플릿])
오프체인 환불:   checkpoint_r(shared→ckpt) + arkTx_r(ckpt → [user U, boltz B])
온체인 성공:     uclaim child (unrolled shared → 성공 스플릿 + anchor)   ← leaf 4 직접 스펜드
온체인 환불:     urefund child (unrolled shared → 환불 스플릿 + anchor)  ← leaf 5 직접 스펜드
```

스플릿 아웃풋은 각자의 **표준 vtxo 스크립트**(owner+server / owner CSV exit)로 — 평범한 새 vtxo가 됨.
- 보내기(a 지불): 성공 = {user U−a, boltz B+a}, 환불 = {U, B}
- 받기(a 수취): 성공 = {user U+a, boltz B−a}, 환불 = {U, B}
- v1 수수료 = 0 (델타 = 정확히 a; LN 라우팅은 boltz 흡수 — 현행 plain과 동일 first-cut).
  스플릿 계산기에 fee 파라미터만 뚫어두고 값은 0.

### 3.3 사전서명 12개 — 전체 상호교환

각 측이 child tx 6개(checkpoint_c, arkTx_c, checkpoint_r, arkTx_r, uclaim, urefund)에 서명해
상대에게 준다 (합계 12). **양쪽 다 양 결과를 모두 밀 수 있게** — 근거:
- claim 실행엔 preimage가 필요하므로 사전서명 소지만으로는 못 씀.
- 상대방에게 유리한 tx를 대신 실행하는 건 항상 무해 (자기 손해 방향).
- 이러면 T 이후 환불을 **어느 쪽이든** 밀 수 있어 "환불 실행자가 영영 안 나타나 collateral이
  만료까지 잠기는" 문제가 소멸.

### 3.4 펀딩 세리머니 (안전 불변식 포함)

REST 2왕복 + 폴링. boltz가 코디네이터(제출/finalize 담당).

```
[보내기 ARK→LN]
1. bridge → POST /v2/subdust/atomic/send/init
   {invoice, userPubkey, userInput{outpoint, tapscripts, amount, expiresAt}, ...}
   boltz: 자격검사(양측) → 자기 collateral 인풋 선정 → T/d₁/d₂/스플릿 확정 → 전체 tx 세트
   결정적 구성 → 자기 사전서명 6개 생성
   ← {swapId, boltzInput, 파라미터 전부, unsigned tx 세트, boltz presigs 6}
2. bridge: 전체 tx 세트를 **로컬에서 독립 재구성 → 바이트 비교** + boltz presig 6개 검증
   (verify-before-sign — 어긋나면 즉시 abort, 아무 것도 서명 안 함)
   → 자기 presigs 6 + funding 인풋 서명 + 자기 checkpoint 서명 생성, DB 영속
   → POST /v2/subdust/atomic/send/presign {swapId, user presigs 6, funding sig, checkpoint sig}
3. boltz: user presig 6개 검증 → 자기 funding/checkpoint 서명 → SubmitOffchainTx → FinalizeOffchainTx
   → LN pay (아래 3.6 타이밍 규율) → settle 시 preimage로 오프체인 claim 실행
   실패(terminal) 시: bridge 온라인이면 cancel leaf 협력 취소, 아니면 T 후 refund push
4. bridge: 폴링/WS로 종결 확인. preimage 수령(결제 증빙).

[받기 LN→ARK]
0. bridge가 preimage P 생성, H=sha256(P). → POST /v2/subdust/atomic/receive/init
   {amount, paymentHash H, descriptionHash?, userPubkey, userInput...}
   boltz: hold invoice(H, descHash) 발급 ← {swapId, invoice}
1. bridge가 invoice를 외부 결제자에게 전달 (noffer 등). 외부 결제 → hold accept 시점에
   세리머니 재개 (위 1-3과 동일 구조, claimer=user).
2. 펀딩 완결 후 bridge가 P로 오프체인 claim 실행 → POST .../receive/settle {swapId, preimage}
   → boltz가 hold invoice settle. (boltz는 claim tx witness에서도 P를 읽을 수 있음 — settle 콜은
   지연 단축용.) 미클레임 시 T 후 boltz가 refund push + invoice cancel → 외부 결제자 자동 환불.
```

**안전 불변식:**
- 사전서명 12개 교환·검증 **완료 전에는 누구도 funding에 서명하지 않는다.**
- 받은 tx 세트는 반드시 로컬 독립 재구성 후 바이트 비교 (blind sign 금지).
- 세리머니 중단(상대 무응답 등) 시 자기 vtxo를 **자기에게 send**하면 떠 있는 funding 서명이
  무효화됨 (인풋 소멸) — 명시적 abort 수단으로 문서화/구현.
- 진행 중 swap의 인풋 vtxo는 refresh/settle 인텐트에 넣지 않는다 (arkd가 어차피 거부:
  `service.go:556-559` — 클라이언트도 락 관리로 이중 방지).

### 3.5 상태머신 + 영속화

**boltz** (pg 테이블 `subdust_atomic_swaps`): id, direction, invoice, payment_hash, amount,
T, d1, d2, user_pubkey, user_input(json), boltz_input(json), shared_outpoint, tx_set(json),
presigs_theirs(json), presigs_ours(json), preimage?, state, created_at, updated_at.
state: `init → presigned → funded → (send) ln_inflight → claimed | (recv) awaiting_claim →
settled` + `cancelled | refund_wait → refunded | failed`. 부팅 시 미종결 swap 재개
(ln_inflight 추적 재개, T 경과분 refund push, hold invoice 정리). T 만료 스캔 cron.

**bridge** (sqlite 마이그레이션, 번호는 머지 시점 main 기준 재확인): `atomic_swaps` 미러 테이블
(presig 세트 포함) — 부팅 시 미종결 swap 재개(refund executor, receive claim 재시도).

### 3.6 파라미터 (초안 — 스파이크 후 §8에서 확정)

- T: 펀딩 시점 + 30~60분 (CLTV 절대시간). 짧게(§1.5).
- **보내기 LN pay 규율 (자금 안전 — 수용 아닌 필수):** `sendPayment`에 cltv_limit을 T−margin에
  맞게 설정 + T−margin 이후에는 신규 pay 시도 금지. LN이 T 넘어 settle되는데 유저가 refund를
  이미 민 상황(boltz 이중 손실)을 구조적으로 차단.
- d₁: 서버 unilateralExitDelay 최소값, d₂: d₁ + 여유 (VHTLC 관례 참조해 확정).
- 인풋 자격: amount ≥ dust + a **AND** expiresAt > now + T + margin (batch expiry 필터, §1.6).

## 4. 아키텍처 / 구현 표면

```
bridge repo (이 레포 — 에픽 브랜치가 곧 여기)
  src/atomic/            프로토콜 코어: 스크립트 빌더, 결정적 tx 빌더, presign/검증, 스플릿 계산
  src/ln_send.ts         <330 분기를 atomic으로 교체 (plain 분기 제거)
  src/clink/offers.ts    sub-dust 받기를 atomic으로 교체 (preimage를 자기가 쥐므로 9735 발행 단순화)
  sqlite 마이그레이션     atomic_swaps
  regtest-e2e/           드릴 매트릭스 확장

my-server repo (별도 — 에픽 머지 시점에만 손댐, §6 해당 하위작업에 명시)
  patches/boltz-subdust-api.patch → atomic 라우터로 개정 (SubdustAtomicRouter + collateral 지갑
  + pg 테이블; plain 라우터/모델 제거). bump-stack.sh 재빌드. SUBDUST_LN_PATCH.md 개정.

boltz 쪽 코드 작업은 ../boltz-backend (reference 클론, 핀 태그 checkout) 위에서 하고
patch 재생성으로 my-server에 백업하는 기존 플로우 그대로.
```

**미확정 (Phase 0 스파이크가 §8에 결정 기록):**
- boltz 쪽 ARK 지갑 전략: fulmine엔 이런 API가 없다 → (α) boltz 패치에 ts-sdk 임베드 자체
  collateral 지갑(자기 키, operator가 fulmine에서 탑업) vs (β) fulmine 확장(Go, 무거움).
  α 우선 검토. collateral 지갑의 refresh/만료 관리 운영 부담 포함해 평가.
- 프로토콜 코어 lib 공유: bridge가 소스 오브 트루스, boltz 패치에 vendored 사본이 유력
  (패치 파일 배포 모델과 정합). 스파이크에서 확정.

## 5. 작업 프로세스 (에픽 브랜치 + 워크트리)

- 에픽 브랜치: `epic/atomic-subdust` (main에서 분기). 상주 워크트리 `.worktrees/atomic-epic`.
- 하위작업 브랜치: `asub/NN-이름` (에픽에서 분기) → 작업 → 운영자 리뷰 → **에픽으로 머지**.
  전부 끝나면 에픽 → main 머지. main 체크아웃은 항상 main에 머문다 (운영 코드 스왑 방지).

```bash
# 하위작업 시작
git worktree add .worktrees/asub-01-poc -b asub/01-regtest-poc epic/atomic-subdust
cd .worktrees/asub-01-poc && bun install
# 완료 후 (리뷰 통과 뒤) — 머지는 에픽 워크트리에서
cd ../atomic-epic && git merge --no-ff asub/01-regtest-poc
# 이 문서 §6 체크박스 갱신 커밋도 여기서
git worktree remove ../asub-01-poc && git branch -d asub/01-regtest-poc
```

- 워크트리 `data/`는 각자 빈 상태 — **운영 sqlite를 절대 가리키지 않는다.**
- boltz 클론(../boltz-backend)은 워크트리 밖 공유 자원 — 스파이크/구현 중 체크아웃 어지럽히면
  `bump-stack.sh` 점검모드로 핀 태그 복원 확인.
- sqlite 마이그레이션 번호는 에픽 중 main에 다른 마이그레이션 랜딩 시 머지 전 재번호 (append-only).

## 6. 하위작업

상태: ⬜ 대기 / 🔧 진행 중 / ✅ 에픽 머지됨. 크기: S(반나절 이하) / M(하루 내외) / L(수일).

### Phase 0 — 검증 스파이크 (여기서 죽으면 플랜 수정이 제일 싸다)

- ⬜ **#01 `asub/01-regtest-poc`** (L) — **에픽 전체의 관문.**
  boltz 없이 순수 ts-sdk 지갑 2개 + regtest arkd로 프로토콜 코어 왕복:
  5-leaf 공유 아웃풋 2-input 펀딩(멀티파티 SubmitOffchainTx+Finalize) → (i) 사전서명 세트로
  상대 오프라인 상태에서 오프체인 claim 성공, (ii) 별도 라운드로 CLTV refund 성공, (iii) cancel
  leaf 협력 취소 성공. §2.5의 실증 항목 전부 여기서: 커스텀 스크립트 수락, BuildTxs 바이트
  패리티(ts-sdk 조립 vs arkd 재구성), finalize 신원 무관.
  산출: `test/spike/atomic_poc.spike.ts`(regtest 전용) + §8 결정 기록. regtest 하네스는
  `regtest-e2e/` 기존 것 재사용.
  DoD: claim/refund/cancel 3경로 regtest green. **여기 통과 못 하면 에픽 중단하고 플랜 수정.**

- ⬜ **#02 `asub/02-unroll-poc`** (M)
  #01 위에서 일방 경로: shared vtxo unroll(기존 exit 머신 재사용) → 사전서명 uclaim 브로드캐스트
  컨펌(d₁ 경과 후), 별건으로 urefund(d₂ 경과 후). anchor/CPFP 1P1C 포함.
  DoD: 두 child 모두 regtest 컨펌. §8에 d₁/d₂/T 확정값 기록.

- ⬜ **#03 `asub/03-boltz-wallet-spike`** (M)
  boltz 쪽 지갑 전략 결정(§4 미확정 α/β): 패치 내 ts-sdk 임베드 가능성(Node 호환, GetInfo에서
  checkpointTapscript 취득, 자기 vtxo 조회/서명), collateral 운영 플로우(fulmine→탑업, 만료 관리),
  프로토콜 lib vendored 사본 전략. 산출: §8 결정 기록 + 최소 동작 증명 스크립트.
  DoD: 결정 기록 작성 + boltz 프로세스 안에서 자기 vtxo로 서명 1회 성공.

### Phase 1 — 프로토콜 코어 라이브러리 (bridge `src/atomic/`)

- ⬜ **#04 `asub/04-script-builder`** (M)
  5-leaf VtxoScript 빌더 + 스왑 파라미터 구조체(방향, a, T, d₁, d₂, 키, 인풋, 스플릿) +
  자격조건 검사(§3.6 인풋 자격) + 스플릿 계산기(fee 파라미터 자리만). #01 채취 fixture로
  arkd Go 인코딩과 교차검증 단위 테스트.
  DoD: 단위 테스트 + typecheck green.

- ⬜ **#05 `asub/05-tx-builder-presign`** (L)
  결정적 tx 세트 빌더(funding / checkpoint+ark 쌍 ×2 / 온체인 child ×2, §3.2) + 사전서명
  생성·검증 헬퍼(부분서명 schnorr 검증 — verify-before-sign 불변식 구현) + PSBT 직렬화 규격
  (양측 공용 와이어 포맷 — boltz vendored 사본이 그대로 쓸 수 있게 의존성 최소화).
  DoD: #01 PoC를 이 lib 기반으로 재작성해 regtest green (spike 코드 폐기).

- ⬜ **#06 `asub/06-state-machine`** (M)
  상태머신(§3.5) + 재시작 재개 규칙 + presig blob 저장 포맷. bridge sqlite 마이그레이션
  `atomic_swaps`. 순수 로직 — 배선 없음.
  DoD: 인메모리 sqlite 단위 테스트 (상태 전이 표 전부 + 재개 시나리오).

### Phase 2 — boltz 패치 (../boltz-backend 위, patch 재생성은 #16)

- ⬜ **#07 `asub/07-boltz-collateral-wallet`** (M~L)
  #03 결정 구현: collateral 지갑(키 관리, vtxo 조회, 인풋 선정 §3.6, 동시 swap 간 인풋 락),
  operator 탑업 절차 문서화(runbook — fulmine sendOffchain으로 충전).
  DoD: regtest에서 탑업→인풋 선정→서명 왕복.

- ⬜ **#08 `asub/08-boltz-send`** (L)
  `SubdustAtomicRouter` 보내기: `POST /v2/subdust/atomic/send/init`·`/presign`·`GET /status`.
  pg 테이블 + 상태머신 + 재시작 재개 + T 만료 refund cron + **LN pay 타이밍 규율(§3.6 —
  cltv_limit, T−margin 컷오프)** + terminal fail 시 cancel/refund 분기.
  DoD: regtest e2e (bridge 모킹 클라이언트로 happy + LN fail + T refund).

- ⬜ **#09 `asub/09-boltz-receive`** (L)
  받기: hold invoice(H, descriptionHash 지원 — 기존 patch의 LND 확장을 hold 계열로) →
  accepted 훅에서 세리머니 → settle 콜(preimage 검증) 또는 claim tx 감시로 settle →
  미클레임 T 후 refund + invoice cancel.
  DoD: regtest e2e (happy + 미클레임 refund + 외부 결제자 환불 확인).

- ⬜ **#10 `asub/10-boltz-remove-plain`** (S)
  plain 경로 제거: `SubdustRouter`의 `/receive`·`/send`·`/address`, `SubdustSend` 모델,
  `addPlainInvoiceWithDescriptionHash`는 hold 계열로 대체됐으면 정리. 에러 코드
  `ATOMIC_LIQUIDITY_UNAVAILABLE` (자격조건 미달) 확정.
  DoD: 라우트 목록에 plain 부재 + 컴파일 green.

### Phase 3 — bridge 통합

- ⬜ **#11 `asub/11-bridge-send`** (M)
  `src/ln_send.ts` <330 분기를 atomic 클라이언트로 교체: 자격조건 사전검사(자기 쪽) →
  세리머니(§3.4) → 종결 대기 → 실패 유형별 에러 표면화(NWC 에러 매핑 포함). refund executor
  (T 후 push, 부팅 재개). 진행 중 인풋의 refresh 제외 락.
  DoD: regtest 드릴 + 단위 테스트.

- ⬜ **#12 `asub/12-bridge-receive`** (M)
  `src/clink/offers.ts` sub-dust 분기 교체: preimage 생성·영속 → receive/init → invoice 전달 →
  accepted 세리머니 응답 → claim 실행 → settle 콜 → **9735 zap receipt를 자기 preimage로 발행**
  (plain 시절 `clink_subdust_receipts`+reconciler 경로는 atomic 전환에 맞게 대체/정리 —
  restart-safe 성질은 유지).
  DoD: regtest 드릴 (zap 흐름 포함) + 단위 테스트.

- ⬜ **#13 `asub/13-vault-integration`** (S)
  진행 중 shared vtxo + 사전서명 온체인 children(uclaim/urefund)을 proof vault에 편입 —
  ASP 사망 시 /exit 탭에서 보이고 수동 집행 가능하게. 자동 집행은 백로그.
  DoD: vault에 행 생김 + /exit 표시 확인 (regtest).

- ⬜ **#14 `asub/14-dashboard`** (S)
  대시보드: 진행 중 atomic swap 목록(상태/타임락 카운트다운) + 수동 액션(refund now, cancel).
  DoD: 로컬 확인.

### Phase 4 — 검증 + 배포 + 머지

- ⬜ **#15 `asub/15-drill-matrix`** (L)
  regtest e2e 드릴 매트릭스 (regtest-e2e/): 보내기 happy / LN terminal fail 협력취소 /
  T refund(bridge push, boltz push 각각) / 받기 happy(zap 포함) / 받기 미클레임 refund /
  unilateral 2종(#02 재현을 e2e로) / **양측 재시작 재개**(펀딩 후 boltz 재시작, claim 전
  bridge 재시작). 전 시나리오 잔액 대사(스플릿 정확성).
  DoD: 매트릭스 전부 green, CI/스크립트화.

- ⬜ **#16 `asub/16-mainnet-deploy`** (M) — **my-server 레포 작업 포함**
  patch 재생성(`patches/` 개정) → `bump-stack.sh` 재빌드/배포 → mainnet 21 sats 실측
  **양방향** (보내기 zap out + 받기 noffer zap in). bridge 배포.
  DoD: mainnet 양방향 아토믹 21 sats 성공 + preimage/스플릿 대사.

- ⬜ **#17 `asub/17-docs-merge`** (S)
  `SUBDUST_LN_PATCH.md` 개정(plain 경로 historical로 강등, atomic 본문 승격), CLAUDE.md
  차별화 #5 갱신, 메모리 갱신, 에픽 → main 머지.
  DoD: 문서 3종 갱신 + 머지 완료.

## 7. 리스크

**수용됨 (운영자 결정 2026-07-14, v1 무대응 — §1.6):**
- 상대방 unroll 무감시. 스펜트 vtxo 사기 unroll엔 표준 대응 수단이 존재하지만(§3.1) 자동화 안 함.
- batch expiry: 인풋 expiry 필터 + 짧은 T로만 관리. swap이 expiry에 걸리는 경우 = 손실 가능.
- 그리핑(세리머니 오픈 후 방치 → boltz collateral T까지 락): rate-limit 없음. 심해지면 후속.

**구현으로 막아야 하는 것 (수용 아님):**
- LN in-flight가 T를 넘는 창 — §3.6 타이밍 규율(cltv_limit + 컷오프)이 필수 구현. 놓치면 boltz 이중 손실.
- blind sign — verify-before-sign 불변식(§3.4). 놓치면 자금 전액 탈취 벡터.
- 사전서명 유실 — DB 영속(§1.4) + 부팅 재개. 유실 = 해당 결과 경로 실행 불능.

**낮음/모니터링:**
- checkpointTapscript(서버 설정) 변경 시 오프체인 presig 무효(온체인 child는 생존 — vtxo 직접
  스펜드라 checkpoint 무관). self-host라 설정 변경은 본인 통제.
- arkd bump 시 BuildTxs 로직 드리프트 → 패리티 회귀 테스트(#01 fixture)를 bump 절차에 편입.
- collateral 지갑 vtxo 만료 관리 — runbook(#07)로 운영 커버.

## 8. 결정 기록 (스파이크가 채움)

- [x] 2026-07-14 (에픽 개시, 운영자): plain 폴백 완전 제거 / uniform 자격조건(측당 단일 vtxo
  ≥ dust + a) / 사전서명 DB 영속 / T 짧게 / known-risk 3종 수용(§1.6).
- [x] 2026-07-14 (설계): 사전서명 12개 전체 상호교환(§3.3 근거) / cancel leaf 포함(라이브
  cosign 전용) / refund는 CLTV 필수(사전서명이 VHTLC의 라이브-cosign 보호를 대체하므로) /
  세리머니 abort = 자기 인풋 self-send.
- [ ] #01: 커스텀 5-leaf 수락 여부, BuildTxs 패리티, wire 포맷 확정.
- [ ] #02: T / d₁ / d₂ 확정값.
- [ ] #03: boltz 지갑 전략(α/β), 프로토콜 lib vendored 사본 전략.

## 9. 백로그 (에픽 스코프 밖)

- multi-input 조합 (측당 여러 vtxo 합산으로 자격조건 충족) — 프로토콜은 이미 허용, 조합 로직만.
- 수취측 자격조건 완화 (≥ dust면 충분 — uniform rule 완화).
- unroll 워처 (상대 unroll 감지 → 자기 child 자동 브로드캐스트; #13의 vault 편입이 발판).
- 그리핑 rate-limit / collateral 상한.
- 수수료 정책 (델타에 fee 편입 — 계산기 파라미터는 #04에 이미 있음).
- **빈 지갑(spendable vtxo 0) 유저의 아토믹 받기 — 원리적으로 불가** (접을 밸런스가 없음).
  제품 카피에 각주 필요: 첫 수신만은 온보딩(≥dust) 이후. plain 경로 제거로 이 케이스는 명시적 에러.
