# ATOMIC_SUBDUST_PLAN.md — 아토믹 sub-dust LN swap 에픽 (v2, 단일 펀더 설계)

> **이 문서가 에픽의 단일 진실.** 세션이 끊겨도 이 문서만 읽고 이어서 작업한다.
> 하위작업 상태는 §6 체크박스로 추적하고, 상태 갱신 커밋은 에픽 브랜치에서 한다.
>
> **v2 (2026-07-14, 같은 날 재설계):** 운영자의 두 번째 통찰로 2자 collateral 설계(v1, git 히스토리
> `a4b7096`)를 폐기하고 **단일 펀더** 설계로 전면 교체. 사전서명 12→2, 멀티파티 펀딩 소멸,
> collateral 소멸, 빈 지갑 받기 성립. v1 대비 차이는 §8 결정 기록.
>
> 세션 재개 절차: ① 이 문서 통독 → ② §6에서 다음 ⬜ 하위작업 확인 → ③ §8 결정 기록에
> 선행 스파이크 결과가 채워졌는지 확인 → ④ 워크트리 파서 작업. §2는 재검증 불필요(코드 인용 완비).
>
> 코드 인용 관례: `레포명 경로:라인` 텍스트로 쓴다 (예: `arkd internal/core/application/service.go:806`).
> reference 클론들은 워크스페이스 한 단계 위 `../`에 있다 — 커밋되는 문서라 상대 링크 금지.
> 라인 번호는 2026-07-14 시점 클론 기준 (arkd v0.9.10 checkout). bump 후 어긋나면 심볼명으로 재탐색.

## 0. 목적 + 핵심 아이디어

**sub-dust 금액(<330 sats)의 LN swap을 양방향 아토믹하게** — 현행 plain 경로(아토믹 포기,
`SUBDUST_LN_PATCH.md`)를 완전히 대체. 제품 카피가 "21 sats zap 가능"에서
**"21 sats zap, 아토믹"**으로 승격. ARK 진영 어디에도 없는 구성 (킬러기능).

**통찰 1 (2026-07-14 오전):** sub-dust가 안 되는 건 *아웃풋*이 dust 미만이라 온체인 청구권이
소멸하기 때문 → 금액을 아웃풋이 아니라 **사전서명된 두 상태(성공/환불 스플릿) 간 델타**로 접는다.

**통찰 2 (2026-07-14, 이 문서의 기반):** 스플릿 아웃풋 자체는 sub-dust여도 된다 — 그건 각자의
키로 떨어지는 **표준 ARK sub-dust vtxo**(OP_RETURN recoverable)일 뿐이고, dust 이상이어야 하는 건
**공유 중간상태(펀딩 아웃풋)와 환불 경로**뿐이다. 따라서:
- 반대쪽(claimer)의 인풋이 필요 없다 → **펀딩은 funder 혼자, 자기 vtxo 하나로** 한다.
- 환불은 100% funder 몫이라 스플릿 강제가 필요 없다 → **환불 경로는 사전서명 불필요**.
- 사전서명은 claim 스플릿 쌍(checkpoint + ark tx)에 대한 **funder의 부분서명 2개가 전부**.

**통합 프로토콜 (방향 대칭):** funder F가 자기 vtxo V를 4-leaf 스크립트로 펀딩하고 claim 스플릿
{F: V−a, C: a}를 사전서명. claimer C는 preimage로 T 전에 클레임, F는 T 후 전액 환불.
- 보내기(ARK→LN, 유저가 a 지불): F=유저, C=boltz. boltz는 펀딩+사전서명 확인 후 LN pay.
- 받기(LN→ARK, 유저가 a 수취): F=boltz, C=유저. hold invoice(유저 생성 preimage) → accepted 시
  boltz가 펀딩 → 유저가 claim → preimage로 LN settle. **유저는 vtxo가 하나도 없어도 됨.**

아토믹성의 소재: F는 preimage 공개 없이 V를 잃지 않고(T 후 전액 환불 + 일방탈출), C는 preimage를
공개해야만 a를 얻는다. sub-dust인 조각(a, 그리고 V−a<dust인 체인지)만 ARK 표준 sub-dust
시맨틱스(ASP-협력 집행, recoverable)를 가진다 — **근본 한계를 sub-dust 조각에만 국한**시킨 구성.

## 1. 요구사항 (운영자 지시, 2026-07-14 확정)

1. **양방향 아토믹, plain 경로(비아토믹)는 폴백 없이 완전 제거.** `/v2/subdust/receive`·`/send`·
   `/address` + `SubdustSend` 모델 + bridge plain 분기 전부. 진행 불가 조건은 명시적 에러로 중단.
2. **자격조건 (v2에서 거의 소멸):**
   - 보내기: 유저에게 spendable vtxo(≥ dust) **아무거나 1개** — a < dust ≤ U라 항상 커버.
     인풋은 v1 스코프에서 1개만 사용.
   - 받기: 유저 조건 **없음** (빈 지갑 OK — 펍키만). boltz는 dust+ vtxo 아무거나 1개
     (가능하면 ≥ dust+a 선호 — 체인지도 정규 vtxo가 되도록. §3.6).
3. **사전서명·스왑 상태는 DB 영속.** 인메모리 금지. boltz는 pg, bridge는 sqlite.
4. **T(환불 타임락)는 짧게.**
5. **known-risk 수용 (기록만, v1 무대응):**
   - claimer의 델타 a는 ASP-협력 집행만 가능(온체인 경로에선 sub-dust 소각) — sub-dust의
     근본 한계. 보내기에선 claimer=boltz(운영자)라 무의미, 받기에선 유저 몫이나 불가피.
   - mid-swap unroll로 델타 절도(≤ a < 330, unroll fee가 수십 배라 경제적 비합리) — 워처 없음.
   - batch expiry: 인풋 expiry 필터 + 짧은 T로만 관리.
   - 받기 방향 그리핑(hold 걸어놓고 미클레임 → boltz vtxo T까지 락): rate-limit 없음.
     (보내기 그리핑은 v2에서 구조적으로 소멸 — boltz 사전 커밋 자본 0.)

## 2. 코드 검증 결과 (arkd v0.9.10, 2026-07-14 세션 — 재검증 불필요하도록 기록)

**arkd 패치 불필요** — 필요한 프리미티브 전부 현행 코드에 있음.

### 2.1 커스텀 스크립트 아웃풋 생성·스펜딩 자유

- 아웃풋 스크립트는 생성 시점엔 검사 안 함(스펜딩 때 taptree 공개 방식) → 커스텀 공유 아웃풋
  생성은 funder의 평범한 오프체인 send로 가능.
- 협력(오프체인) 스펜딩 허용 closure: `MultisigClosure` | `CLTVMultisigClosure` |
  `ConditionMultisigClosure` (`arkd internal/core/application/service.go:806-818`).
  CLTV는 제출 시점 블록시간 검사 (`service.go:820-851`) + ark tx nLockTime에 반영
  (`arkd pkg/ark-lib/offchain/tx.go:126-151`) → 온체인 일관성.
- 스크립트 유효성: 협력 leaf(forfeit closure)엔 signer 키 필수, exit leaf는 CSV ≥ 서버 최소
  (`arkd pkg/ark-lib/script/vtxo_script.go:97-165`). hashlock condition은 VHTLC가 프로덕션 실증.

### 2.2 사전서명 성립 (설계의 심장)

- txid는 witness 제외 해시 → 서명 전 확정.
- `BuildTxs`는 (인풋, 아웃풋, checkpointTapscript)만으로 완전 결정적 (`offchain/tx.go:31-73`).
  checkpoint 아웃풋 = `{server unroll CSV, 원본 vtxo의 collaborative closure 그대로}`
  (`offchain/tx.go:183-185`) → claim leaf의 다자 구성이 checkpoint에 상속, 사전서명 우회 불가.
- `FinalizeOffchainTx`는 서명만 검증, 제출자 신원 무관 (`service.go:1104-1164`, 특히 1144-1149)
  → funder 오프라인이어도 claimer가 사전서명 세트만으로 완결 가능.
- 금액 보존 강제: inputAmount == outputAmount (`offchain/tx.go:63-65`).

### 2.3 sub-dust 아웃풋 규칙 (v2에서 load-bearing)

- 오프체인 ark tx의 non-OP_RETURN 아웃풋은 ≥ dust 강제 (`service.go:4577-4579`).
- **sub-dust 아웃풋은 OP_RETURN subdust 포맷으로 허용** (`service.go:4520-4541`) — 단
  value ≥ `vtxoMinAmount` (`service.go:4529-4538`) — recoverable vtxo가 됨. 오늘 plain 받기가
  21 sats vtxo를 만드는 것과 동일 물건. → claim 스플릿의 a(그리고 V−a<dust인 체인지)가 이 형태.
- sub-dust/swept vtxo는 **인풋**으로는 거부 `VTXO_RECOVERABLE` (`service.go:681-685`) —
  펀딩 인풋은 반드시 정규(≥dust) vtxo.
- OP_RETURN 개수 상한 존재: `maxOpReturnOutputs` 설정 (`service.go:431`, 카운트 4486-4488).

### 2.4 스파이크로 확인할 것 (§6 #01)

- 4-leaf 커스텀 스크립트의 펀딩→claim(sub-dust 스플릿 포함)→refund→cancel 전 과정 arkd 수락.
- ts-sdk 조립 tx와 arkd 재구성(`service.go:946`)의 바이트 패리티.
- **서버 설정 실측값**: dust(=330?), `vtxoMinAmount`(a 하한), `maxOpReturnOutputs`
  (U−a<dust 케이스는 스플릿에 OP_RETURN 2개 — 상한이 1이면 그 엣지만 명시 에러로 거부).
- SDK의 subdust OP_RETURN 아웃풋 인코딩 유틸 존재 여부 (fulmine은 만들 줄 안다 — plain 받기 실증).

## 3. 프로토콜 설계

### 3.1 공유 아웃풋 스크립트 (4-leaf)

F = funder, C = claimer, H = payment hash, a = 결제 금액, V = F의 펀딩 vtxo 금액.

| # | leaf | closure | 용도 | 사전서명 |
|---|------|---------|------|---------|
| 1 | claim | `ConditionMultisig{hashlock(H), [F, C, server]}` | C가 preimage로 스플릿 실행 | **F가 claim 쌍 2개** |
| 2 | refund | `CLTVMultisig{T, [F, server]}` | T 후 F 전액 회수 | 불필요 (스플릿 없음) |
| 3 | cancel | `Multisig{[F, C, server]}` | 합의 즉시 unwind (라이브 cosign만) | 불필요 |
| 4 | uexit | `CSVMultisig{d, [F]}` | 일방탈출 (unroll 후 F 전액) | 불필요 (F 단독 leaf) |

- claim leaf만 F+C 2자(+server) — 스플릿 금액의 강제 수단이 사전서명뿐이라서. 나머지 leaf는
  전액이 한쪽 몫이라 다자 강제가 필요 없음 → **사전서명은 claim 쌍(checkpoint_c + arkTx_c)에
  대한 F의 부분서명 2개가 전부.** C는 클레임 시 자기 서명+preimage를 얹고 server가 countersign.
- refund에 CLTV(T) 필수: F 단독(+server) leaf라서 T 없으면 LN in-flight 중 회수 가능 → 깨짐.
- cancel leaf: LN terminal 실패 등에서 **양쪽 라이브 합의**로 T 대기 없이 즉시 원복(전액 F).
  사전서명이 없으므로 어느 쪽도 일방 실행 불가 = 위험 0.
- uexit: CSV(d)는 서버 최소 exit delay. CLTV 없음(closure 타입에 CSV+CLTV 조합 없음) —
  이로 인한 mid-swap unroll 절도는 §1.5 수용 (한도 a, fee가 수십 배).
- v1의 uclaim(일방 성공) leaf는 **삭제**: 스플릿의 sub-dust 조각이 온체인에선 소각이라 수혜자가
  브로드캐스트할 이유가 없는 경제적 무가치 경로 (§8 결정).

### 3.2 트랜잭션 세트

```
funding:  F의 정규 vtxo V 1개 → [shared (V, 4-leaf), anchor]     ← F 혼자 만드는 평범한 오프체인 send
claim 쌍: checkpoint_c(shared→ckpt V) + arkTx_c(ckpt → 스플릿 + anchor)   ← 사전서명 대상
refund:   T 후 F가 라이브로 구성 (leaf 2, 전액 자기 주소 — 사전 구성 불필요)
cancel:   합의 시점에 라이브로 구성 (leaf 3, 전액 F)
uexit:    unroll(기존 exit 머신) 후 leaf 4로 라이브 sweep
```

claim 스플릿 규칙 (`arkTx_c` 아웃풋):
- C의 a: a < dust이므로 **항상 OP_RETURN subdust 아웃풋** (C 키로 — recoverable vtxo).
- F의 체인지 V−a: ≥ dust면 정규 P2TR vtxo, < dust면 OP_RETURN subdust (0이면 아웃풋 생략).
- 수수료 v1 = 0 (델타 = 정확히 a; LN 라우팅 boltz 흡수 — 현행과 동일 first-cut). 계산기에
  fee 파라미터 자리만.

### 3.3 방향별 플로우

```
[보내기 ARK→LN]  F=유저(bridge), C=boltz
1. bridge → POST /v2/subdust/atomic/send/init {invoice, userPubkey}
   ← {swapId, boltzPubkey, T, d, serverParams}     (boltz 자본 커밋 없음 — 펍키만)
2. bridge: 4-leaf 스크립트+funding tx 구성 → funding 제출(자기 단독 send) →
   claim 쌍 사전서명 2개 생성, DB 영속
   → POST .../send/fund {swapId, fundingOutpoint, presigs}
3. boltz: 인덱서로 funding 조회 → 스크립트=기대 taptree(자기 키·H·T·d로 재구성) + V ≥ ? 검증
   + presig 2개 검증 + payment_hash dedup → LN pay (§3.5 타이밍 규율)
   → settle: preimage로 claim 실행 (a는 자기 키의 subdust vtxo로) → status=claimed
   → terminal fail: bridge 온라인이면 cancel 협력 unwind, 아니면 bridge가 T 후 refund
4. bridge: 폴링으로 종결 확인, preimage 수령(결제 증빙).

[받기 LN→ARK]  F=boltz, C=유저(bridge)
0. bridge: preimage P 생성·영속, H=sha256(P)
   → POST /v2/subdust/atomic/receive/init {amount, paymentHash H, descriptionHash?, userPubkey}
   ← {swapId, invoice(hold, H, descHash)}          → 인보이스를 외부 결제자에게 (noffer)
1. 외부 결제 → hold accepted → boltz: vtxo 선정 → 스크립트+funding 구성·제출 →
   claim 쌍 사전서명 → status={fundingOutpoint, params, presigs}
2. bridge(폴링): funding 스크립트·금액·presig 전부 독립 재구성·검증 → P로 claim 실행
   (a는 자기 키의 subdust vtxo — 오늘 plain 받기와 동일 물건) → POST .../receive/settle {swapId, P}
3. boltz: P 검증 → hold invoice settle. (claim tx witness에서도 P 확인 가능 — settle 콜은 지연 단축)
   미클레임: T 후 boltz refund(자기 leaf) + invoice cancel → 외부 결제자 자동 환불.
```

**안전 불변식 (v2에서 대폭 축소):**
- **verify-before-act**: 상대가 만든 스크립트/tx/presig는 반드시 로컬 독립 재구성 후 바이트
  비교·서명 검증. (blind trust 금지 — 남은 유일한 치명 벡터.)
- C는 **funding 온레저 확인 + presig 검증 완료 후에만** 가치를 지출한다 (boltz: LN pay 전 /
  유저: preimage 공개 = claim 제출 전). 순서 인터락은 이게 전부 — funding과 presig 전달의
  상호 순서는 안전에 무관 (한쪽만 있으면 아무 일도 안 일어나고 T 후 원복).
- payment_hash로 스왑 dedup (동일 인보이스 재사용 거부 — pg PK).
- 진행 중 인풋/공유 vtxo는 refresh 인텐트에서 제외 (arkd도 거부: `service.go:556-559`).
- 세리머니 중단: funder가 자기 인풋을 self-send하면 미제출 funding은 무효. 제출된 funding은
  cancel(합의) 또는 T 후 refund.

### 3.4 상태머신 + 영속화

**boltz** (pg `subdust_atomic_swaps`): id, direction, payment_hash **UNIQUE**, invoice, amount,
T, d, user_pubkey, funding_outpoint, script_params(json), presigs(json), preimage?, state,
created_at, updated_at.
- send: `init → funded(presig 검증됨) → ln_inflight → claimed | cancelled | refunded(T후 유저측) | failed`
- receive: `invoice_issued → hold_accepted → funded → claimed → settled | refund_wait → refunded | failed`
- 부팅 재개: ln_inflight 추적 재개, T 경과분 refund 실행(receive는 invoice cancel 동반), hold 정리.
  T 만료 스캔 cron.

**bridge** (sqlite `atomic_swaps`, 마이그레이션 번호는 머지 시점 main 기준): 방향, swapId,
preimage(받기), presigs(보내기 — 자기가 F), funding_outpoint, state, 부팅 재개
(보내기: T 후 refund executor / 받기: 미완 claim 재시도·settle 재시도).

### 3.5 파라미터 (초안 — 스파이크 후 §8 확정)

- T: 펀딩 + 30~60분 (CLTV 절대시간).
- **보내기 LN pay 규율 (자금 안전 — 수용 아닌 필수 구현):** cltv_limit ≤ T−margin,
  T−margin 후 신규 pay 금지. LN이 T 넘어 settle됐는데 유저가 refund 민 이중손실 창 차단.
  pay 직전 funding unspent/not-unrolled 확인.
- d: 서버 unilateralExitDelay 최소값 그대로.
- a 하한 = `vtxoMinAmount` (스파이크 실측), a 상한 = dust−1 (이상은 기존 VHTLC 스왑).
- 인풋 자격: funder vtxo expiresAt > now + T + margin (batch expiry 필터).
- boltz 인풋 선호: B ≥ dust+a (체인지 정규화, OP_RETURN 1개 유지). 유저 보내기의 U−a<dust
  엣지는 maxOpReturnOutputs 실측값에 따라 허용/명시 에러 (§2.4).

## 4. 아키텍처 / 구현 표면

```
bridge repo (이 레포)
  src/atomic/            프로토콜 코어: 4-leaf 스크립트 빌더, 결정적 tx 빌더(funding/claim 쌍),
                         presign 생성·검증, 스플릿 계산기(subdust OP_RETURN 인코딩 포함)
  src/ln_send.ts         <330 분기를 atomic 보내기로 교체 (plain 분기 제거)
  src/clink/offers.ts    sub-dust 받기를 atomic으로 교체 — preimage를 자기가 생성하므로
                         9735 zap receipt 발행이 자기 preimage로 단순화
  sqlite 마이그레이션     atomic_swaps
  regtest-e2e/           드릴 매트릭스 확장

my-server repo (별도 — 머지 시점에만, §6 #14)
  patches/boltz-subdust-api.patch → SubdustAtomicRouter로 개정 (plain 라우터/모델 제거),
  bump-stack.sh 재빌드, SUBDUST_LN_PATCH.md 개정.
**boltz 워크플로 (2026-07-15 운영자 결정 — fork/branch 모델로 전환):**
- boltz 커스터마이즈의 **진실 = 개인 fork `github.com/tajava2006/boltz-backend`의 `atomic-subdust`
  브랜치** (boltz 릴리스 태그 위 우리 커밋들). `reference/boltz-backend` remote: `origin`=fork,
  `upstream`=BoltzExchange(태그 pull용). 개발·테스트는 이 브랜치에서 real git으로 (patch 손유지 폐기).
- **⚠ 마인넷 배포는 아직 plain 패치 유지** (atomic-subdust 브랜치는 #08~#10 미완). `bump-stack.sh`는
  당분간 **plain-patch 모델 그대로** — 미완 브랜치를 빌드하지 않게. 배포 전환은 **#15**에서.
- **#15 배포 시**: 완성된 브랜치에서 `git diff <tag>..atomic-subdust`로 patch 재생성(→ plain 대체) 하고
  bump-stack을 브랜치-빌드(또는 재생성 패치 적용)로 전환. 업그레이드는 `fetch upstream → rebase <새태그>
  atomic-subdust → push -f origin` 수동 스텝(충돌은 사람이). patch 파일은 그때부터 **생성 산출물**(감사·복구용).
- 벤더 재생성 규율: bridge `src/atomic` 변경 시 boltz `lib/atomic` 6파일 재복사(단일 진실=bridge).
```

**boltz 쪽 ARK 능력 요구 (v2에서 축소됐지만 잔존 — fulmine엔 없는 것들):**
- 보내기: **키 연산만** — claim 쌍에 자기 서명 + SubmitOffchainTx/Finalize 호출. vtxo 불필요.
- 받기: 자기 키로 서명 가능한 정규 vtxo 1개 + funding 구성·제출 + presign + T 후 refund.
- 전략 스파이크(#03): (α) 패치에 ts-sdk 임베드 자체 키/미니 지갑(operator가 fulmine에서 탑업)
  vs (β) fulmine 확장. α 우선. **운영 아이디어**: 스플릿의 boltz 수취(a, B−a)를 fulmine 펍키로
  보내면 fulmine 장부 가시성 + recoverable 통합을 공짜로 얻음 (서명키와 수취키는 달라도 됨).
- 프로토콜 코어 lib 공유: bridge가 소스 오브 트루스, boltz 패치에 vendored 사본 유력. #03 확정.

## 5. 작업 프로세스 (에픽 브랜치 + 워크트리)

- 에픽 브랜치: `epic/atomic-subdust` (main에서 분기). 상주 워크트리 `.worktrees/atomic-epic`.
- 하위작업 브랜치: `asub/NN-이름` (에픽에서 분기) → 작업 → 운영자 리뷰 → **에픽으로 머지**.
  전부 끝나면 에픽 → main 머지. main 체크아웃은 항상 main에 머문다.

```bash
git worktree add .worktrees/asub-01-poc -b asub/01-regtest-poc epic/atomic-subdust
cd .worktrees/asub-01-poc && bun install
# 완료 후 (리뷰 통과 뒤) — 머지는 에픽 워크트리에서
cd ../atomic-epic && git merge --no-ff asub/01-regtest-poc
git worktree remove ../asub-01-poc && git branch -d asub/01-regtest-poc
```

- 워크트리 `data/`는 각자 빈 상태 — 운영 sqlite 절대 금지.
- boltz 클론은 워크트리 밖 공유 자원 — 어지럽히면 `bump-stack.sh` 점검모드로 핀 확인.
- sqlite 마이그레이션 번호는 머지 전 main 기준 재번호 (append-only).

## 6. 하위작업

상태: ⬜ 대기 / 🔧 진행 중 / ✅ 에픽 머지됨. 크기: S(반나절 이하) / M(하루 내외) / L(수일).

### Phase 0 — 검증 스파이크

- ✅ **#01 `asub/01-regtest-poc`** (L) — **에픽 전체의 관문. 2026-07-15 regtest GREEN (11/11), 에픽 머지됨.**
  boltz 없이 ts-sdk 지갑 2개 + regtest arkd로 단일 펀더 프로토콜 왕복:
  4-leaf 펀딩(단독 send) → (i) F 오프라인 상태에서 presig 2개로 C의 claim 성공 — **sub-dust
  스플릿 포함** (a subdust + 체인지 정규 / 체인지도 subdust 두 케이스), (ii) CLTV refund,
  (iii) cancel 협력 unwind. + §2.4 실측: BuildTxs 패리티, dust/vtxoMinAmount/maxOpReturnOutputs,
  SDK subdust 아웃풋 인코딩. 산출: `test/spike/atomic_poc.spike.ts`.
  DoD: 3경로 regtest green. **통과 못 하면 에픽 중단, 플랜 수정.** → **통과. 설계 유지, #02+ 진행 가능.**
  실측·결정은 §8 [#01] 참조.

- ✅ **#02 `asub/02-unroll-poc`** (S) — **2026-07-15 regtest GREEN (9/9), 에픽 머지됨.**
  #01 위에서 F의 일방 경로: shared vtxo unroll(기존 exit 머신 재사용) → d 경과 → leaf 4로
  전액 sweep. (claimer 쪽 일방 경로는 설계상 없음 — 소각 확인만 기록.)
  DoD: regtest 컨펌 + §8에 T/d 확정값. → **통과.** 산출: `test/spike/atomic_unroll.spike.ts`.
  실측·결정은 §8 [#02] 참조.

- ✅ **#03 `asub/03-boltz-ark-spike`** (M) — **2026-07-15 regtest GREEN (8/8), 에픽 머지됨. α 확정.**
  boltz 쪽 ARK 능력 전략(§4 α/β): 패치 내 ts-sdk 임베드(Node 호환, GetInfo 파라미터 취득,
  서명·제출), 받기용 미니 지갑(탑업·만료 관리 runbook 초안), fulmine 펍키 수취 아이디어 검증,
  프로토콜 lib vendored 전략. DoD: §8 결정 + boltz 프로세스 안에서 서명·제출 1회 성공.
  → **통과.** 산출: `test/spike/atomic_boltz.spike.cjs`(Node CJS). 결정은 §8 [#03] 참조.

### Phase 1 — 프로토콜 코어 (bridge `src/atomic/`)

- ✅ **#04 `asub/04-script-and-splits`** (M) — **2026-07-15 GREEN (34 유닛테스트), 에픽 머지됨.**
  4-leaf VtxoScript 빌더 + 스왑 파라미터 구조체(방향, a, H, T, d, 키들, V) + 스플릿 계산기
  (a subdust 인코딩, 체인지 정규/subdust/생략 3분기, fee 자리) + 인풋 자격 필터(expiry).
  #01 fixture로 arkd 인코딩 교차검증. DoD: 단위 테스트 + typecheck green. → **통과.**
  산출: `src/atomic/{script,params,split,eligibility,index}.ts` + `test/unit/atomic_*.test.ts`.
  4개 leaf 인코딩을 **#01/#02서 arkd가 수락한 바이트 그대로** 회귀 fixture로 고정(드리프트 감지).
  typecheck green, 전체 스위트 339 pass/0 fail.

- ✅ **#05 `asub/05-tx-builder-presign`** (M) — **2026-07-15 GREEN (유닛 6 + #01 재작성 10/10 regtest), 에픽 머지됨.**
  결정적 tx 빌더(funding / claim 쌍) + presig 생성·검증(부분서명 schnorr — verify-before-act)
  + 와이어 포맷(PSBT base64 — boltz vendored 사본이 그대로 쓰게 의존성 최소화)
  + refund/cancel/uexit 라이브 구성 헬퍼. DoD: #01 PoC를 이 lib로 재작성해 green (spike 폐기). → **통과.**
  산출: `src/atomic/tx.ts`(buildClaimPair·presignClaim·verifyPresig·withPreimage·finishClaim·
  collaborativeSpend/refundSpend/cancelSpend·buildUexitSweep·PSBT wire) + `test/unit/atomic_tx.test.ts`
  + `test/spike/atomic_poc.spike.ts`(이제 lib 구동). 전체 유닛 135 pass.

- ✅ **#06 `asub/06-state-machine`** (S) — **2026-07-15 GREEN (19 유닛), 에픽 머지됨. Phase 1 완료.**
  양측 상태머신(§3.4) + 재개 규칙 + bridge sqlite `atomic_swaps`. 순수 로직.
  DoD: 인메모리 sqlite 단위 테스트 (전이 표 + 재개 시나리오). → **통과.**
  산출: `src/atomic/{state,repository}.ts` + db.ts 마이그레이션 v2(append-only, ⚠ main 머지 시 재번호) +
  `test/unit/atomic_{state,repository}.test.ts`. canTransition/assertTransition/isTerminal/classifyResume,
  payment_hash UNIQUE dedup(DuplicateSwapError), transition()이 상태머신 강제, listResumable() 부팅 재개.
  전체 스위트 364 pass/0 fail.

### Phase 2 — boltz 패치 (../boltz-backend 위, patch 재생성은 #14)

- 🔧 **#07 `asub/07-boltz-ark-layer`** (M) — **2026-07-15 코어 완료(in-tree 컴파일 green), 잔여 e2e는 #14.**
  #03 결정 구현: 키/서명·제출 레이어 + 받기용 vtxo 관리(선정 §3.5, 동시 스왑 락, 탑업 runbook).
  DoD: regtest에서 서명·제출·(받기용) 펀딩 왕복. → **핵심 성립.** 상세 §8 [#07].
  - bridge `asub/07`(에픽 머지): `src/atomic` **의존성 최소화**(직접 @scure/btc-signer import 2건 제거 —
    conditionScript 손인코딩 + verifyPresig를 F 펍키 존재검사로) → 벤더 사본이 btc-signer 버전 안 섞음. 유닛 154 + #05 재검 10/10.
  - boltz `atomic-subdust` 브랜치(v3.13.0 위, 격리): `@arkade-os/sdk` 의존성 추가(설치·로드·컴파일 OK) +
    `lib/atomic/`(코어 벤더, sqlite repository 제외) + `lib/atomic/ArkSigner.ts`(SingleKey+REST providers,
    Wallet 없이, 받기 미니지갑 vtxo 선정). boltz strict tsc에서 lib/atomic 에러 0.
  - 잔여(머지 전): ArkSigner 구동 boltz-프로세스 regtest 왕복은 #14 드릴에 편입(서명·제출은 #03/#05 실증).

- 🔧 **#08 `asub/08-boltz-send`** (M) — **2026-07-15 코어 완료(typecheck green), e2e 잔여. boltz 브랜치 push됨.**
  `SubdustAtomicRouter` 보내기: `/send/init`·`/send/fund`·`GET /status`. pg 테이블 +
  payment_hash dedup + funding/presig 검증 + **LN pay 타이밍 규율(§3.5)** + claim 실행기 +
  terminal fail 시 cancel 협력/방치 + 부팅 재개. (v1 대비 급감: collateral·세리머니 없음.)
  DoD: regtest e2e (모킹 클라이언트로 happy + LN fail + T refund). → **코어 성립, e2e 잔여.**
  boltz `atomic-subdust` 브랜치(fork push): `lib/db/models/SubdustAtomicSwap.ts`(sequelize, paymentHash
  UNIQUE dedup)·`ArkConfig` 확장(subdustRestUrl/SignerKey/sendWindow/payMargin/blockTime)+`ArkClient.subdustConfig`·
  `lib/api/v2/routers/SubdustAtomicRouter.ts`(init/fund/status: 스크립트 재구성 → 인덱서로 funding 조회
  (verify-before-act) → 스플릿 재계산 → verifyPresig → **LN pay 타이밍(payMargin 내면 거부, cltvLimit=
  remaining/blockTime)** → finishClaim) + ApiV2/Database 배선. 벤더 lib/atomic 사용. 내 파일 tsc 에러 0
  (ArkClient의 proto import 에러는 기존 — `npm run compile:rust` 미실행). **잔여: regtest e2e(모킹 클라)
  + 부팅 재개 executor.**

- 🔧 **#09 `asub/09-boltz-receive`** (L) — **2026-07-15 코어 완료(typecheck green), e2e 잔여. boltz 브랜치 push됨.**
  받기: hold invoice(H, descriptionHash — 기존 patch LND 확장을 hold 계열로) → accepted 훅에서
  펀딩+presign → status 노출 → settle 콜(P 검증) → 미클레임 T 후 refund + invoice cancel.
  DoD: regtest e2e (happy + 미클레임 refund + 외부 결제자 환불 확인). → **코어 성립, e2e 잔여.**
  boltz `atomic-subdust`(fork push): `SubdustAtomicRouter`에 받기 추가 — `/receive/init`(**LND hold invoice**
  `addHoldInvoice`, descriptionHash zap 지원)·`htlc.accepted` 훅(`onHoldAccepted`: `selectFunding` 미니지갑
  → **`fundShared`**(V=a+dust, 클레임 체인지 정규) → `presignClaim`)·`/receive/status`(펀딩·presig·boltz펍키·T·d
  노출)·`/receive/settle`(sha256(P)==H 검증 → `settleHoldInvoice`)·`refundReceive`+`resumeExpiredReceives`
  (T 경과 미클레임 → refund leaf + `cancelHoldInvoice`, 타이머는 #14). bridge lib에 `fundShared`(no-Wallet
  펀더 빌더) 추가·에픽 머지·재벤더. boltz LndClient는 hold invoice 완비(add/settle/cancel/subscribe 확인).
  **잔여: regtest e2e + 타이머 스케줄.**

- ⬜ **#10 `asub/10-boltz-remove-plain`** (S) — **대부분 N/A: 브랜치엔 plain 라우터가 애초에 없음(#15 배포 시 자동).**
  plain 경로 제거: `/subdust/receive`·`/send`·`/address`, `SubdustSend`. 에러 코드 확정
  (예: `NO_ELIGIBLE_VTXO`(보내기 인풋 없음), `SUBDUST_EDGE_REJECTED`(maxOpReturn 엣지)).
  DoD: plain 라우트 부재 + 컴파일 green.
  → **`atomic-subdust` 브랜치는 v3.13.0 + atomic만이라 plain 라우터/모델을 아예 안 가짐**(plain은 옛 patch에만
  존재, 마인넷 live). #15 배포에서 브랜치가 plain 패치를 대체 = plain 자동 제거. 잔여 폴리시: 에러 코드 명시화(소).

### Phase 3 — bridge 통합

- 🔧 **#11 `asub/11-bridge-send`** (M) — **2026-07-15 코어 완료(typecheck+suite green), 에픽 머지. 드릴은 #14.**
  `src/ln_send.ts` <330 분기 교체: vtxo 선택(자격 필터) → init → 펀딩+presign → fund 콜 →
  종결 대기 → 실패 유형별 에러 표면화(NWC 매핑). T 후 refund executor(부팅 재개), cancel 응답,
  진행 중 vtxo의 refresh 제외. DoD: regtest 드릴 + 단위 테스트. → **코어 성립.**
  산출: `src/atomic_send.ts`(bridge=F: init→4-leaf 스크립트→`Wallet.sendBitcoin`로 shared 펀딩(V=a+dust,
  순비용=a)→`computeClaimSplit`→`presignClaim`→/send/fund→종결. 각 단계 `atomic_swaps`(SqliteAtomicSwapRepository)
  영속). ln_send.ts <330 분기가 이걸 호출, plain sendSubdust 제거. arkServerUrl/db를 pay_invoice·service·web에
  배선. 옛 plain 유닛테스트 삭제(제거된 코드)·submarine 유지, suite 359 pass. **잔여(#14 타이머와 함께): T-refund
  executor(부팅 재개 over atomic_swaps) + 진행 중 shared vtxo의 consolidate-all refresh 제외.**

- ✅ **#12 `asub/12-bridge-receive`** (M) — **2026-07-16 코어+배선 완료, 에픽 머지.**
  `src/clink/offers.ts` sub-dust 분기 교체: P 생성·영속 → init → invoice 전달 → status 폴링 →
  검증 → claim → settle 콜 → **9735를 자기 preimage로 발행** (plain 시절 reconciler 경로 대체,
  restart-safe 유지). DoD: regtest 드릴 (zap 포함) + 단위 테스트.
  → **코어**: `src/atomic_receive.ts`(issueAtomicReceive: P 생성→/receive/init(hold)→atomic_swaps 영속
  (P 저장)→invoice+P 반환 / driveAtomicReceive: status 폴링→funded면 verify+claim+settle, restart-safe /
  driveAtomicReceives: 부팅+주기 패스). **#14 받기 e2e(7/7)가 검증한 바로 그 흐름.**
  → **배선(완료)**: `ln_receive.issueInvoice` sub-dust 분기 → issueAtomicReceive (IssuedInvoice
  subdust에 swapId+preimage 동반). plain `reconcileSubdustReceives` → `reconcileAtomicReceives`
  (driveAtomicReceives 후 payment_hash로 transactions 행을 자기 P로 settled 플립, grace 넘으면 expired).
  clink/offers.ts sub-dust ack reconciler는 `getByPaymentHash(...).preimage`로 9735/zap 발행(boltz 폴링 X).
  arkServerUrl+db를 make_invoice·service·clink·index에 배선. 옛 plain 유닛테스트 삭제(제거된 코드).
  typecheck green, suite 351 pass / 0 fail. **마인넷 배포는 #15까지 plain boltz 유지(정합).**

- ✅ **#13 `asub/13-vault-dashboard`** (S→M) — **2026-07-16 완료, 에픽 머지 (`e66f90d`). 설계 근거
  전문은 §8 "in-flight 자금과 vault" 문답 기록 참조.**
  → 산출: 마이그레이션 v3(exit_vtxos.source + atomic_swaps.peer_pubkey/exit_delay — 스크립트 재조립이
  boltz 재문의 없이 행만으로 성립) / proof_sync `captureVtxo`(지갑 밖 vtxo 1회성 미러, 패스 fetch/store
  재사용) / GC 사라짐 루프 source='atomic' skip / atomic_send 펀딩 시 캡처(best-effort — 미러 실패가
  스왑을 못 죽임)·claimed 시 행 해제 / `refundAtomicSend`(refund leaf CLTV T, F+server; funded·
  ln_inflight·refund_wait에서 T 경과 시) / `/swaps` 탭(진행중+최근, T 카운트다운, 수동 Refund 버튼 —
  refundAtomicSend 게이트와 동일 조건에만 노출, PRG) / EXIT_DESIGN.md §3 atomic-source 절.
  exitPaths() 회귀 assert 포함 테스트 12개 추가, suite 360 pass. **cancel(3-of-3)은 의도적 미배선**
  (boltz cosign 엔드포인트 필요; T가 짧고 refund가 안전성 커버 — 필요시 백로그).
  (a) **vault 편입 (보내기만)**: `exit_vtxos`에 `source` 컬럼('wallet'|'atomic', 마이그레이션) +
  펀딩 직후 shared vtxo의 chain+proof 명시적 캡처(ProofSync 헬퍼 재사용) + ProofSync GC 사라짐
  루프에 source='atomic' skip 가드(getExitOp 가드와 동형 — 행 소유권은 atomic 스왑 생애주기) +
  종료 상태(claimed/canceled/refunded) 도달 시 행 삭제 + gcOrphanProofs + `exitPaths()`가 atomic
  tapTree의 uexit leaf를 인식하는 회귀 assert. EXIT_DESIGN.md §3에 포인터 추가.
  (b) **대시보드**: 진행 중 스왑 목록(방향/상태/T 카운트다운) + 수동 refund 액션(T 후, F+server —
  boltz 불필요). cancel(3-of-3)은 boltz cosign 엔드포인트가 필요해 구현 시 스코프 판단.
  DoD: vault 행 + /exit 표시 + 대시보드 로컬 확인 (regtest).

### Phase 4 — 검증 + 배포 + 머지

- ✅ **#14 `asub/14-drill-matrix`** (L) — **2026-07-17 regtest 풀 매트릭스 100% GREEN.** 아래 드릴 8종 전부 통과 + 프로덕션 wrapper 실측 중 상태머신 버그 1개 잡아 수정.
  regtest e2e 매트릭스: 보내기 happy(체인지 정규/subdust 두 케이스) / LN fail cancel /
  T refund / 받기 happy(zap 포함, **빈 지갑 수신**) / 받기 미클레임 refund / F uexit(#02 재현) /
  **양측 재시작 재개**(펀딩 후 boltz 재시작, claim 전 bridge 재시작). 전 시나리오 잔액 대사.
  DoD: 전부 green, 스크립트화.
  → **보내기 happy + 받기 happy + 보내기 LN-fail 3종 실측 통과 (2026-07-16)**: 커스텀 boltz
  (`boltz-atomic:regtest`, Dockerfile SOURCE=local 빌드)를 arkade-regtest에 `BOLTZ_IMAGE` 스왑.
  - `atomic_send_e2e.spike.ts` (6/6): 21 sats LN 실결제 + 원자 claim (#08 보내기+#11).
  - `atomic_receive_e2e.spike.ts` (7/7): **빈 지갑 bridge**가 hold invoice로 21 sats 원자 수신 (#09,
    addHoldInvoice→htlc.accepted 훅→fundShared→presign→claim→settleHoldInvoice). boltz 미니지갑 펀딩 필요.
  - `atomic_send_fail_e2e.spike.ts` (4/4): 취소된 hold invoice로 LN 강제 실패 → boltz status=failed +
    **shared vtxo 미소비**(절도 불가, 유저 refund 가능) = 트러스트리스 보장.
  Phase 2 boltz 라우터(#08/#09)+#11+벤더 lib+커스텀 boltz 빌드 전부 실동작 확인. 런북은 커밋 메시지.
  → **T-refund 실측 GREEN + 타이머 완성 (2026-07-16)**:
  - `atomic_refund_e2e.spike.ts` (10/10): **프로덕션 `refundAtomicSend`** 실측 — 행만으로 4-leaf 재조립
    → refund leaf(CLTV T, F+server) → 전액 V 복귀 → state=refunded + vault 행 해제 + **잔액 대사 net 0**.
    #13 `captureVtxo`도 real 인덱서 상대 exit-ready 확인. pre-T 로컬 거부 확인.
    ⚠ **발견: arkd는 CLTV를 blocktime(MTP류) 기준으로 집행** — wall clock보다 뒤짐(유휴 regtest ~35분,
    mainnet ~1h). T 직후 refund는 `FORFEIT_CLOSURE_LOCKED`으로 튕김 → `RefundNotYetError`로 매핑,
    executor는 waiting 처리(다음 틱 재시도), 대시보드 에러 메시지에 지연 설명 포함.
  - **타이머(executor)**: `resumeAtomicSends` — classifyResume(§3.4) 그대로. post-T→refund(단 boltz
    도달 가능하면 status 1회 확인: claim 후 크래시 행은 refund 대신 claimed로 대사+preimage 저장+vault
    해제), pre-T→boltz 폴링(failed→refund_wait). index.ts 기존 30s reconcile 틱에 배선(부팅+주기).
    유닛 7종(크래시 대사/불통/blocktime lag/스왑별 격리). suite 367 pass.
  → **배선 실측 + exit-엔진 소유 GREEN (2026-07-17, regtest 풀 매트릭스)**:
  - `atomic_wired_e2e.spike.ts` (10/10): **프로덕션 wrapper** 첫 실측 — bridge B `issueAtomicReceive`+
    `driveAtomicReceive` 수신 / bridge A `atomicSubdustSend` 송신, 각자 Wallet+db(운영자 "두 bridge"의
    실질). ⚠ **버그 캐치**: atomicSubdustSend가 funded→claimed 직행(상태머신 위반) → mainnet이면 boltz
    결제·claim 후 throw(돈 나가고 실패 보고) → funded→ln_inflight→claimed로 수정. ⚠ **닫힌 루프 불가**:
    두 bridge가 한 boltz(=한 LN 노드) 공유라 A→B는 boltz-lnd 자기지불(LND 거부) → 각 측 외부 lnd 상대.
    **mainnet 테스트 설계에도 적용**: 두 bridge 직접 루프 X, 각자 외부 LN 상대여야.
  - `atomic_exit_plan.spike.ts` (9/9): **#13 payoff** — listVaultVtxos에 source 필터 없어 atomic 행이
    이미 /exit 탭+엔진에 흘러듦. 실제 캡처 행으로 estimateExit(**uneconomical=true, fee 12054 > V 351**
    = 경제성 실측)·buildExitStepper(실체인 unroll DAG 18 levels)·availableExitPath(uexit leaf, CSV 512s
    게이팅) 전부 통과. 온체인 unroll+sweep 실행은 #02가 증명(모든 vtxo 동일 코드).
  - `atomic_boltz_restart_e2e.spike.ts` (7/7): receive fund+presign 직후 `docker restart boltz`
    미드스왑 → 복귀 후 swap 'funded' 유지(pg 영속) → driveAtomicReceive claim+settle 완료 → 수신값 생존.
    배포 시 boltz 재빌드가 in-flight 수신을 안 버림 확인. **regtest 매트릭스 100% 완료.**
  **매트릭스 상태**: 보내기 happy(코어+wrapper)·받기 happy(코어+wrapper, 빈지갑)·보내기 LN-fail·T-refund
  (프로덕션)·resume executor(유닛7)·exit-엔진 소유(#13 payoff)·boltz 재시작 — **전부 GREEN**.
  - 보내기 subdust-change 케이스 — **프로덕션 N/A**: atomicSubdustSend는 항상 V=a+dust(체인지=정규 dust).
    subdust 체인지 분기는 #01에서 프로토콜 레벨 검증 완료.
  - #11 잔여였던 consolidate-all refresh 제외 — **구조적 N/A**: shared vtxo는 지갑 주소 세트 밖이라
    refresh 수집 대상에 애초에 안 들어감(§8 2026-07-16 문답의 같은 원리).
  ⚠ 셋업 함정: block 모드(tree expiry 20블록+자동채굴)면 펀더 vtxo 즉시 만료 → **seconds 모드** 필수. hold invoice는 boltz-lnd에 있음(lnd 아님).

- ⬜ **#15 `asub/15-mainnet-deploy`** (M) — **my-server 레포 작업 포함**
  patch 재생성 → `bump-stack.sh` 재빌드/배포 → bridge 배포 → mainnet 21 sats **양방향** 실측
  (보내기 zap out + 받기 noffer zap in, 빈 지갑 케이스 포함 여부는 운영 계정 사정에 따라).
  DoD: mainnet 양방향 아토믹 21 sats 성공 + preimage/스플릿 대사.

- ⬜ **#16 `asub/16-docs-merge`** (S)
  `SUBDUST_LN_PATCH.md` 개정(plain historical 강등, atomic 승격), CLAUDE.md 차별화 #5 갱신,
  메모리 갱신, 에픽 → main 머지. DoD: 문서 3종 + 머지 완료.

## 7. 리스크

**수용됨 (운영자, §1.5):** claimer 델타의 ASP-협력 집행 / mid-swap unroll 절도(≤a) /
batch expiry 필터만 / 받기 그리핑 무대응.

**구현으로 막아야 하는 것 (수용 아님):**
- LN in-flight가 T를 넘는 창 — §3.5 타이밍 규율 필수. 놓치면 boltz 이중 손실.
- verify-before-act 불변식 — 상대 구성물 blind 신뢰 금지. 놓치면 스플릿 변조/전액 탈취 벡터.
- 사전서명·preimage 유실 — DB 영속 + 부팅 재개. 유실 = 해당 경로 실행 불능.
- payment_hash dedup — 동일 인보이스 이중 스왑 차단 (pg UNIQUE).

**낮음/모니터링:**
- checkpointTapscript(서버 설정) 변경 시 presig 무효 — self-host, 설정 본인 통제. F는 T 후
  refund로 항상 원복 가능이라 자금 손실은 아님(스왑만 실패).
- arkd bump 시 BuildTxs 드리프트 — #01 패리티 fixture를 bump 절차 회귀 테스트로 편입.
- boltz 수취(a)가 subdust recoverable로 누적 — fulmine 펍키 수취(§4)로 가시성 확보, 만료 시
  ASP 재흡수(운영자 net 0, 오늘 bound-키 vtxo와 동일 성질).

## 8. 결정 기록

- [x] 2026-07-14 (에픽 개시): plain 폴백 완전 제거 / 사전서명 DB 영속 / T 짧게 / known-risk 수용.
- [x] 2026-07-14 (**v2 재설계, 운영자 통찰**): **단일 펀더 채택** — 스플릿 아웃풋은 sub-dust 허용
  (표준 recoverable 시맨틱스), dust 이상 요구는 공유 중간상태+환불 경로에만. 결과: 멀티파티
  펀딩·collateral·12개 사전서명·uniform 자격조건 전부 폐기 (v1 설계는 `a4b7096` 히스토리).
  사전서명 = F의 claim 쌍 2개. 빈 지갑 받기 성립. 보내기 그리핑 구조적 소멸.
- [x] 2026-07-14 (v2 세부): uclaim leaf 삭제(온체인 소각이라 경제적 무가치) / cancel leaf 유지
  (라이브 cosign 전용) / refund·uexit는 F 단독 leaf로 사전서명 불필요 / 순서 인터락 축소
  (C의 "검증 후 지출"만 남음) / payment_hash dedup 승계 (bound-address 트릭은 스크립트 내
  H 포함으로 대체 — 스크립트 자체가 바인딩).
- [x] 2026-07-15 (운영자 질의로 재확인): **cancel leaf는 정규 swap에도 있는 표준 패턴** —
  프로덕션 VHTLC의 무타임락 refund leaf(`ts-sdk packages/ts-sdk/src/script/vhtlc.ts`의
  `refundScript` = `Multisig[sender, receiver, server]`, 3자 라이브 cosign)가 정확히 같은 물건.
  정규 VHTLC는 6-leaf, 우리는 4-leaf — cancel 포함해도 표준보다 단순. 과설계 아님, 유지 확정.
- [x] **#01 (2026-07-15, regtest arkd v0.9.9-rc.0, 11/11 green):** 단일 펀더 설계 **성립 확인**.
  세 경로 전부 arkd 수락 — (i) F 오프라인 후 presig 2개로 C claim (a=21 subdust + 정규 체인지 /
  a=200 subdust + subdust 체인지 두 케이스), (ii) CLTV refund(T 경과 수락 / T 미래 거부 — CLTV 집행
  확인), (iii) F+C+server cancel 협력 unwind. 실측·확정:
  - **dust = 330 sats, vtxoMinAmount = 1 sat** → a 범위 [1, 329]. a 하한은 vtxoMinAmount(=1)이지 dust 아님.
  - **maxOpReturnOutputs ≥ 2**: U−a<dust 엣지(스플릿에 OP_RETURN 2개)를 arkd가 **수락**. ts-sdk
    `buildOffchainTx`도 클라 측 `MAX_OP_RETURN=2` 하드코딩(`utils/arkTransaction.ts:50`) — 우리 스플릿은
    최대 2개라 항상 통과. #04에서 별도 명시-에러 게이팅 불필요(2 초과 케이스가 없음).
  - **BuildTxs↔arkd 패리티 OK, arkd 무패치 확정**: F의 presig txid == C의 결정적 재빌드 txid(바이트
    일치), 그리고 arkd가 submit/finalize 수락 + server 서명이 ts-sdk 조립 tx에 유효 → 재구성 일치.
  - **SDK subdust 인코딩**: `ArkAddress.subdustPkScript` = `OP_RETURN <32B x-only vtxo taproot key>`
    (`ts-sdk script/address.ts:115`). 별도 인코더 불필요 — 이게 recoverable subdust vtxo를 만듦(오늘 plain
    받기와 동일 물건). C가 실제로 subdust vtxo(recoverable) 수령 확인.
  - **와이어 포맷 = PSBT base64**(`Transaction.toPSBT`/`fromPSBT`). presig = F의 tapScriptSig 실린 base64
    PSBT 2개(arkTx + checkpoint). 결정적 txid 덕에 C의 verify-before-act(재빌드+F sig 검증)가 성립.
  - **preimage witness**: claim leaf(ConditionMultisig)는 arkTx·checkpoint **양쪽** 인풋에
    `ConditionWitness=[preimage]`(`setArkPsbtField`) 필요 — arkd가 최종 witness 조립. boltz-swap
    `claimVHTLCIdentity` + `refundVHTLCwithOffchainTx`(3자 combine) 패턴 그대로.
  - **checkpointTapscript = CSV 512s(seconds), d(unilateralExitDelay) = 512s** (아래 #02에서 확정 예정).
  - **⚠ regtest 모드 함정**: ts-sdk `.env.regtest` 기본값은 **block 모드**(delays=20). 이 스파이크는
    **seconds 모드**(CLTV=unix타임스탬프 + MTP 집행) 전제 → exit-drill env override(512/1024s,
    AUTOMINE=30)로 `regtest start --profile ark` 기동해야 함. #02/#14도 같은 방식.
  - 구현 노트: claim은 `refundVHTLCwithOffchainTx`(3자 F+C+server combine) + `claimVHTLCIdentity`
    (preimage) 융합. refund/cancel은 단일-leaf 협력 스펜드 헬퍼(`collaborativeSpend`) 재사용.
- [x] **#02 (2026-07-15, regtest arkd v0.9.9-rc.0 block 모드, 9/9 green):** F 일방탈출 **성립 확인**.
  shared 4-leaf vtxo 펀딩 → `Unroll.Session`(기존 SDK exit 머신)이 체인을 온체인으로 브로드캐스트
  (F onchain 지갑으로 P2A CPFP, 1C1P 패키지 = mempool `/txs/package`) → CSV d 경과 → leaf 4(uexit
  = CSVMultisig[F])로 **전액 V 온체인 sweep** → F onchain 잔고 정확히 V−fee 증가. 확정:
  - **d = 서버 `unilateralExitDelay` 그대로**(§3.5 초안대로). 실측 regtest block 모드 d=20 blocks로
    sweep 성공. mainnet(seconds 모드)은 512s(#01 실측)가 서버 최소 — 그 값 그대로 uexit CSV에 사용.
  - **T (refund CLTV): 프로토콜 하한 없음** — arkd는 T 경과 전 refund만 거부(#01 실측). 따라서 T는
    순수 정책값: §3.5 초안 "펀딩 + 30~60분" 유지. 유일 제약은 §3.5 LN pay 규율(cltv_limit ≤ T−margin).
    #02가 새로 좁힌 건 없음(送 흐름 #08/#11에서 확정).
  - **claimer 일방 경로 없음 확인**: C는 claim·cancel leaf에만 있고 둘 다 server 공동서명 필요.
    유일 CSV(exit) leaf는 uexit=F 단독. C가 온체인에서 realize 가능한 건 sub-dust a(OP_RETURN=소각)
    → mid-swap unroll 절도 한도 ≤ a(§1.5 수용) 구조적 확인.
  - **⚠ #13용 발견**: `VtxoScript.exitPaths()`가 우리 4-leaf에서 **throw**(claim/refund leaf를 CSV로
    디코드 시도 → "expected CHECKSEQUENCEVERIFY DROP"). 즉 SDK 제네릭 exit 리졸버(prepareUnroll
    Transaction→availableExitPath→exitPaths)로는 우리 shared vtxo를 못 몰음. #13(vault·/exit 편입)은
    **uexit leaf를 직접 지정**해 sweep해야 함(이 스파이크의 수동 sweep이 레퍼런스). completeUnroll도
    지갑 소유 vtxo 전제라 불가 — 수동 tx 조립.
  - **⚠ regtest 운영 노트**: #02는 block 모드(빠른 CSV `mine 20`). 단 `ARKD_VTXO_TREE_EXPIRY`를 길게
    (500)—짧으면(기본 20) CSV용 20블록 채굴 중 펀딩 vtxo가 만료·churn. faucet 단위는 **BTC**(sats 아님).
- [x] **#03 (2026-07-15, regtest arkd v0.9.9-rc.0, Node v24 CJS, 8/8 green): α 채택 확정.**
  boltz 쪽 ARK 레이어는 **@arkade-os/sdk 임베드(α)** — fulmine 확장(β) 불필요(적어도 보내기·기본 받기).
  boltz-backend 실측: **CommonJS**(tsconfig module Node20, `type` 미설정), **Node ≥22.4**, ark 의존성 0,
  기존 `ArkClient`는 fulmine 스타일 노드에 **gRPC**(WalletService `sendOffchain`=서버측 키)라 클라 키-op 불가.
  - **α 게이트 통과**: 진짜 리스크는 crypto(#01서 검증)가 아니라 런타임 — SDK가 @noble/curves v2(ESM-only)를
    끌어와 CJS `require`가 깨질 위험. 실측 `require('@arkade-os/sdk')` **정상 로드**(149 exports, tsup CJS
    번들이 @noble 내장). boltz-shaped .cjs 프로세스에서 sign+submit+finalize 1회 성공(보내기 claim, boltz=C).
  - **아키텍처 결정 — Wallet 안 씀**: Node에 **global EventSource 없음** → 풀 `Wallet`(ArkProvider SSE +
    ContractManager)은 shim 필요. 하지만 키-op엔 Wallet 불필요 → **`RestArkProvider` + `RestIndexerProvider`
    + `SingleKey`만** 사용(+ `buildOffchainTx`/`combineTapscriptSigs`/`setArkPsbtField`/`DefaultVtxo.Script`).
    보내기(boltz=C)는 vtxo 0개 순수 키-op. 주소도 Wallet 없이 `DefaultVtxo.Script(...).address()`로 도출.
  - **받기용 미니 지갑 runbook 초안 (boltz=F, #07 확정)**: boltz `SingleKey` 주소를 운영자가 fulmine에서
    주기적 탑업(dust+ vtxo 몇 개 프리펀드). 받기 스왑당 정규 vtxo 1개 선정(동시성 락), funding tx는
    `buildOffchainTx`로 직접 조립. 만료 관리는 인덱서 폴링 + 임박분 refresh(협력 settle) 또는 탑업 케이던스.
    Wallet 불필요(SSE 없이 인덱서 폴링). ⚠ regtest 실측 교훈: 클라 온보딩 vtxo가 만료-갭에 걸리면 인풋
    거부(`ark settle`로 리프레시) — boltz 미니지갑도 만료 여유(expiry > now + T + margin, §3.5) 지켜 선정.
  - **fulmine 펍키 수취(§4 운영 아이디어) — 검증**: 스플릿의 boltz 수취분(보내기 a, 받기 B−a)의 **수취
    주소와 서명 키는 분리 가능**. 스파이크는 boltz 자기 `DefaultVtxo` 주소로 받았지만, 아웃풋 주소를
    fulmine 펍키의 DefaultVtxo 주소로 바꾸면 fulmine 장부 가시성 + recoverable 재흡수를 공짜로 얻음
    (서명은 여전히 boltz 키). 아웃풋은 임의 유효 ARK 주소면 arkd가 수락 → 채택 가능, #08/#09서 반영.
  - **vendored lib 전략 확정**: 프로토콜 코어(4-leaf 스크립트·결정적 tx 빌더·presign·스플릿 계산)는
    bridge `src/atomic/`(#04~#06)가 **source of truth**, boltz 패치는 **vendored 사본**. 둘 다 @arkade-os/sdk
    프리미티브 위에 얇게 얹히므로(#01/#03가 bun-ESM·Node-CJS 양쪽서 동일 동작 확인) vendored 사본은 소형.
    boltz는 CJS라 lib는 CJS-호환(또는 이중) 필요 — #04에서 빌드 타깃 이중(ESM+CJS)로 작성.
  - **잔여(이 스파이크 밖, #07)**: boltz-backend **실제 트리**에 @arkade-os/sdk 의존성 추가 + TS 컴파일
    통과 + 패치 내 import. 이 스파이크는 boltz **런타임 제약**(Node CJS, no Wallet, require 로드) 아래
    sign+submit 성립을 증명 — 실제 in-tree 빌드 편입은 #07.
- [x] **#07 (2026-07-15): α in-tree 통합 성립 + vendored lib 전략 확정.**
  - **@scure/btc-signer 버전 중첩 발견·해소**: boltz는 2.2.0 top-level, SDK는 2.0.1 nested(정확 핀). 벤더
    사본이 `@scure/btc-signer`를 직접 import하면 boltz 2.2.0으로 해석돼 SDK(2.0.1)가 만든 PSBT/Transaction
    객체와 섞임 → **직접 import 전면 제거**(conditionScript 손인코딩 = OP_HASH160<20>OP_EQUAL 바이트 동일,
    tapLeafHash 대신 verifyPresig를 F 펍키 존재검사로 — 인풋에 claim leaf만 있고 txid 이미 대조라 등가).
    남은 의존성은 @arkade-os/sdk + @scure/base(순수 codec, 버전 무해) + node:crypto뿐 → bridge·boltz **동일
    바이트 벤더**.
  - **vendored 전략 확정**: 코어(script/params/split/eligibility/tx/state)만 벤더, **repository(bun:sqlite)는
    제외**(boltz는 pg). boltz `lib/atomic/`에 마커 헤더 + `ArkSigner`(SingleKey+REST providers, Wallet 없음).
    boltz strict tsc(Node20)에서 lib/atomic 에러 0 = #03 잔여(in-tree 빌드) 해결. 의존성 설치도 clean(313 pkg).
  - **ArkSigner API**: getInfo(캐시)·serverXOnly·serverUnroll·receiveAddress(DefaultVtxo, fulmine 펍키 라우팅
    가능)·ownVtxos·selectFunding(받기 미니지갑, eligibility). 서명·제출은 lib tx 함수 그대로 호출.
  - **벤더 재생성 규율**: bridge `src/atomic` 변경 시 boltz `lib/atomic` 6파일 재복사(단일 진실=bridge).
  - 잔여: ArkSigner 구동 boltz-프로세스 regtest 왕복 → #14 드릴 편입(서명·제출은 #03/#05 실증).
- [x] **2026-07-16 (#13 B안 확정 — "in-flight 자금과 vault" 운영자 문답 기록):** shared vtxo의
  proof vault 편입 가치를 검증하다 도달한 이해의 전문 기록. 나중에 다시 읽어도 바로 알 수 있게.
  - **현상은 sub-dust 전용이 아니다.** vault(ProofSync)는 지갑 자기 주소의 vtxo만 미러링한다.
    스왑 in-flight 자금은 — 정규 vHTLC든 우리 atomic shared vtxo든 — 커스텀 스크립트 주소에
    있어 vault에 안 들어감 → ASP가 in-flight 중 죽으면 일방탈출 재료(증명)가 없다. 금액과
    무관한 **"지갑 밖 주소" 일반 현상**. 우리 shared vtxo는 V=a+dust≥330이라 아크 안에선 평범한
    vtxo다(sub-dust인 건 claim 스플릿의 a 조각뿐 — 스크립트 주소에 떨어지는 동전을 설계가
    일부러 dust+로 만들어 둠).
  - **격리 오탐이 아니라 완전 비가시.** 격리는 "vault에 행이 **있는데** live 세트에서 사라졌고
    증거 없음"일 때만 발동(GC는 vault 행만 순회). 오늘의 스크립트 주소 vtxo는 행이 아예 없어
    볼 것도 없음 — **침묵은 안전이 아니라 비가시**. (펀딩에 소모된 지갑 vtxo 쪽은 내 서명이
    스펜딩 tx에 있어 spent-verified로 정당 삭제 — 그 무경보는 정상. evidence는 "누가 썼나"만
    보지 "잘 썼나"는 안 봄.) 격리 오탐은 vault에 행을 *넣기 시작하면* 비로소 생기는 문제:
    지갑 live 세트에 영원히 없는 행이라 매 패스 오탐 + boltz claim(내 서명 아님) 시 또 오탐
    → GC 가드가 필요한 유일한 이유.
  - **정규 ≥dust 스왑도 같은 구멍.** SDK/SwapManager는 boltz 배신 시 환불(협조/일방 leaf)만
    커버, ASP 사망 대비 증명 보존은 없음. 마인넷 무경보 = 안전해서가 아니라 vault가 못 봐서.
    큰 금액은 경제성도 있으므로(수수료 내고도 남음) vHTLC 확장 가치 있음 → §9 백로그. 단
    vHTLC의 일방 refund leaf는 CLTV+CSV 복합이라 exit 엔진 `exitPaths()` 파싱 검증 스파이크
    선행 필요. 우리 uexit leaf는 SDK 표준 CSVMultisig 순정품이라 엔진 무수정(sweep.ts가
    tapTree에서 generic 도출 — DefaultVtxo 하드코딩 없음, 코드 확인). **실측 확정(2026-07-16,
    SDK 0.4.43)**: `VtxoScript.decode(atomic tapTree).exitPaths()` = uexit 1개 정상 반환.
    claim leaf가 ConditionCSV로 오인돼 내부 디코드는 실패하지만 per-leaf try/catch가 잡아
    debug 로그만 남김(무해 소음). #02 당시 "4-leaf에서 throw" 노트는 이 실측으로 무효 —
    단 SDK bump가 throw를 재도입할 수 있으니 #13에서 회귀 assert로 고정.
  - **경제성: 솔로 탈출은 상수 조정으로 못 살린다.** sweep 가드는 "수수료 뺀 후 출력 ≥ 546"
    (SDK 보수 상수. 타프루트의 진짜 온체인 dust는 330 = 아크 dust와 같은 값·같은 기원; 546은
    레거시 P2PKH 기준의 blanket). V=351 → 351−~110(1-in-1-out 최저 수수료) < 546 거부.
    V=a+546=567로 올려도 457 < 546 **여전히 거부** — 예외 제거엔 V ≥ a+546+미래수수료가
    필요한데 수수료율은 펀딩 시점에 미지 → **어떤 상수도 불가**. 게다가 이 가드는 vtxo 종류
    무관 단일 값 체크라 없앨 "예외 처리 로직" 자체가 코드에 없음(평범한 400-sat 잔돈 vtxo도
    동일 거부). 대량 탈출 배치에선 총합 체크라 그냥 실려 나감(throw 없음). dust 상향은 21-sat
    zap 최소 잔고만 351→567로 올려 최소 지갑 케이스를 죽임 → **330 유지**.
  - **용어 교정**: 이 편입이 완성하는 건 "아토믹"(boltz와의 원자성 — HTLC로 이미 확보)이
    아니라 **일방탈출 보장**(ASP 사망 시에도 꺼낼 재료)의 빈틈 메우기.
  - **결정(B안)**: 경제성 없어도 편입 — 철학("모든 vtxo는 내 것, 아무도 안 믿음")의 코드적
    참 + 탈출 실행 여부는 유저 재량. 구현 형태(#13 스펙에 반영):
    (i) **같은 exit_vtxos 테이블 + `source` 컬럼** — 별도 테이블은 exit 소비자 전부(sweep/
    engine/stepper/estimate/vault_indexer/뷰) 수술이 필요해지고, gcOrphanProofs가 exit_vtxos
    에서만 참조를 계산해 swap 행만 참조하는 증명이 고아 오판되는 footgun.
    (ii) GC 사라짐 루프에 source='atomic' skip 가드(기존 getExitOp 가드와 동형) — 행 소유권은
    atomic 스왑 생애주기.
    (iii) 펀딩 시 캡처: "소모한 vtxo의 증거 보존"이 아니라 **"새 vtxo의 증거 신규 캡처"**가
    정확한 메커니즘. proof는 tx 단위 dedupe라 조상 증명은 소모한 인풋 것과 대부분 겹침 —
    신규 fetch는 새 hop(arkTx/checkpoint) PSBT 정도.
    (iv) 종료 시 삭제: claimed(잔돈 dust는 내 정규 주소로 와 기존 ProofSync가 자동 커버)/
    canceled(협조 3-of-3)/refunded(T 후 F+server) → removeVtxo + gcOrphanProofs. 비종료 stuck은
    행 유지 — 여전히 탈출 가능한 자금이니 옳은 동작.
    (v) **보내기만**(받기는 F=boltz — in-flight 위험도 uexit leaf도 boltz 몫).
    (vi) 회귀 고정: atomic tapTree에 `exitPaths()`가 uexit leaf를 인식하는 assert.

## 9. 백로그 (에픽 스코프 밖)

- **정규 vHTLC 스왑의 vault 편입** (§8 2026-07-16 문답에서 발견): in-flight vHTLC 자금도 같은
  "지갑 밖 주소" 구멍 — ASP가 스왑 중 죽으면 일방탈출 재료 없음. 큰 금액이라 sub-dust와 달리
  **경제성 있음**. #13의 source-컬럼 메커니즘 재사용 가능하되, vHTLC 일방 refund leaf(CLTV+CSV
  복합)가 exit 엔진 `exitPaths()`에 파싱되는지 스파이크 선행. 완성 시 "일방탈출 보장"이
  모든 in-flight 자금으로 확장됨.
- **co-funded 받기 (구 v1 설계의 부활 자리)**: 유저가 정규 vtxo를 co-fund하면 수취 a가
  U+a ≥ dust 정규 vtxo가 되어 **완전 일방 집행** 획득 — 잔고 있는 유저용 프리미엄 아토믹 받기.
  멀티파티 펀딩·상호 사전서명 복잡도가 돌아오므로 수요 확인 후.
- multi-input 펀딩 (보내기에서 여러 vtxo 합산 — v1 스코프는 단일 인풋).
- 수수료 정책 (델타에 fee 편입 — #04에 파라미터 자리).
- 받기 그리핑 rate-limit / unroll 워처.
- claimer 클레임 자동화 고도화 (boltz claim 실패 재시도 백오프 등 운영 다듬기).
