# SECURITY_AUDIT.md

> **2026-08-02 전체 앱 보안 감사.** 스코프: `arkade-nwc-bridge` 전체 — 웹/CSRF, NWC/Nostr,
> unilateral exit(증명 GC·sweep·final send), boltz swap(send/receive/offboard), atomic
> sub-dust 클라이언트. atomic(F1~F19)은 별도 `SUBDUST_ATOMIC_SECURITY_REVIEW.md`에서 이미
> 전건 닫혀 있고 그쪽 돈-안전 불변식은 재확인함. 본 문서는 **그 외 영역의 신규 위협**과
> 수정/방치 상태를 추적하는 대장.
>
> **현재 상태 (2026-08-02): CSRF/M2/M3/M6/M7 ✅ 수정, M1 ✅ 수정(잔여 없음), M4/M5 🚫 방치(근거 기록).**
> 외부 코드리뷰 완료 (§리뷰 검증) — 원 지적 8건 전부 실재 확인, 기능 회귀 없음. 리뷰 신규 R1~R4
> → **R1·R2·R3·R4 모두 2차 수정으로 해소(§R1~R4 해소).** 커밋 전(uncommitted).

## 상태표

범례: ⬜ 미해결 / ✅ 수정완료 / ⚠️ 부분수정(잔여 = R항목) / 🚫 수용(방치, 근거 기록)

| # | 제목 | 위협 | 심각도 | 상태 |
|---|------|------|--------|------|
| CSRF | 웹 자금·파괴적 POST 라우트에 인증/CSRF/Origin 검증 전무 (drive-by·DNS-rebinding) | 자금 탈취 | **HIGH** | ✅ Origin+Host 가드 |
| M1 | outgoing `pay_invoice` 재시작 시 `transactions` 영구 pending → 예산 영구 잠김 (swap_id 미기록, 용도 reconcile 0건) | 가용성/예산 DoS | MEDIUM | ✅ swap_id 조기기록 + reconcile(R1·R2 해소) |
| M2 | `pay_invoice` payment_hash 중복결제 방지 없음 (재시도 시 이중 펀딩+수수료 2회+자금 T 락) | 낭비/락 | MEDIUM | ✅ preimage replay + in-flight 거부 |
| M3 | 받기 `settled`를 boltz 말만 믿고 기록+9735 영수증 발행 (Ark vtxo 미검증) | 신용/영수증 위변조 | MEDIUM | ✅ vtxo 착지 확인 게이트 (+R3 createdAt 필터) |
| M4 | primary unroll이 자체 boost 대신 잘못된 SDK `bumpP2A` 사용 → fee 급등 시 자동 중단 | 가용성 | MEDIUM | 🚫 방치 (§방치) |
| M5 | 단일 esplora + error-as-not-found로 중간 unroll 재방송/실패 | 가용성 | LOW | 🚫 방치 (§방치) |
| M6 | NIP-65 릴레이 목록 무제한·scheme/호스트 미검증 → 릴레이 주입/소진 | 가용성 | LOW | ✅ scheme+상한+사설IP 차단 |
| M7 | noffer 릴레이를 attacker 입력 그대로 연결(SSRF) | 내부 접근/스캔 | LOW | ✅ isSafeRelayUrl 게이트 |
| R1 | (리뷰) M1 잔여: submarine(≥dust) 크래시-창 미복구 — swap_id가 settle 시에만 기록돼 resume 매칭 0건 | 예산 영구 잠김 + 해당 인보이스 재시도 불능 | MEDIUM | ✅ onSwapCreated 콜백으로 조기기록 |
| R2 | (리뷰) M1 reconcile의 settled 전이가 `spent_msat`/fees 미반영 → 'never' 예산 과소계상 | 예산 한도 약화 | MEDIUM-LOW | ✅ 원금 반영 (fee는 수용, 근거 기록) |
| R3 | (리뷰) M3 착지 확인이 값-근사 매칭 — 기존 동일액 vtxo에 오탐(동일 액수 반복 zap) | 영수증 위변조 잔존 | MEDIUM-LOW | ✅ createdAt ≥ 스왑 생성 필터 |
| R4 | (리뷰) CSRF 가드가 POST 전용 — DNS-rebinding **GET 읽기**(잔액·히스토리·exit)는 여전히 노출 | 프라이버시 | LOW | ✅ readGuard(Host) 전 GET 적용 |

---

## CSRF — 웹 자금·파괴적 POST 라우트에 CSRF/Origin 검증 전무 [HIGH] ✅

**원인:** `src/web/server.ts` 모든 POST(`/send/confirm`, `/exit/final-send`,
`/exit/:txid/:vout/sweep`, `/swaps/refund`, `/refresh`, `/connections/:id/revoke`,
`/noffer/regenerate`, …)에 Origin/Host/토큰 검증이 한 군데도 없었다. 루프백 바인딩은
"외부 네트워크 노출"만 막을 뿐 **CSRF 제어가 아니다** — 운영자가 브리지를 켠 채 아무 악성
페이지를 열면, 그 페이지가 form POST(단순 요청, CORS preflight/쿠키 불필요)로
`127.0.0.1:4282/send/confirm`에 공격자 인보이스를 쏠 수 있고, 리뷰 페이지 없이 즉시 결제된다.

**수정:** `web/server.ts`에 `csrfGuard(req)` 추가 — 상태변경 POST마다 선두에서
- `Origin`이 존재하면 반드시 loopback + 우리 포트,
- `Host`가 반드시 loopback (DNS-rebinding 차단).
curl·로컬 도구(Origin/Host 불일치 없음)는 통과. 18개 POST 라우트 전체 적용.

---

## M1 — outgoing ledger 재시작 영구 pending + 예산 잠김 [MEDIUM] ✅

**원인:** `pay_invoice.ts`는 outgoing `transactions` 행에 `swap_id`를 안 적어서,
`boltz.ts`의 submarine `syncSwapToDb` 백업 분기(`WHERE type='outgoing' AND swap_id=?`)가
0건 매칭 = 죽은 코드. outgoing 부팅 reconcile도 없음. → 결제 중 브리지 재시작 시 행이
`pending`으로 영구 남고, `'never'` 예산(`budget.ts:81-87`)이 pending outgoing 합계를 세므로
**영구 예산 소모**.

**수정:**
- `ln_send.ts` / `atomic/send.ts`의 `LnSendResult`에 `swapId` 추가 → `pay_invoice.ts` settle
  트랜잭션에서 `swap_id`를 기록 (정상 경로).
- `reconcilePendingIncoming`(기존 incoming boot reconcile)을 **async + wallet 파라미터**로
  확장하고, **outgoing 크래시-창 reconcile 추가**: pending outgoing 행을 payment_hash로
  atomic repo와 매칭해 claimed→settled / refunded·failed→failed 전이. (sub-dust/zap = 주요
  케이스 복구. submarine은 swap_id + SwapManager resume로 복구.)
- `index.ts` 30s 주기 pass에 `reconcilePendingIncoming` 배선 → 재시작 없이도 자가 치유.

**❗ 리뷰 정정 (R1·R2, 2차 수정 해소):** 리뷰 지적대로 원 수정의 "(submarine은 swap_id + SwapManager
resume로 복구)"는 사실이 아니었다 — swap_id가 성공 settle 시에만 기록돼 크래시 시 NULL, resume의
`syncSwapToDb` outgoing 분기 0건 매칭, M2 결합 시 해당 인보이스 재시도 불능. **해소:**
- **(R1)** `ln_send.ts`에 `onSwapCreated` 콜백 추가 → `sendSubmarine`이 `createSubmarineSwap` 직후
  (settle 대기 **전**) 발화, `pay_invoice`가 그 시점에 row의 swap_id를 기록 → 크래시 후 SwapManager
  resume → `syncSwapToDb`가 정상 정리. (INSERT→create 사이의 극소 창은 수용 — 이 구간 크래시는 스왑이
  생성 전이라 복구 대상 아님.)
- **(R2)** outgoing reconcile의 atomic claimed 전이가 `UPDATE … WHERE state='pending'`의 **changes>0** gate로
  `connections.spent_msat += amount_msat` 반영('never' 예산 원금보존). fee(≈0.5%) 미반영은 수용 —
  fee 보관은 `atomic_swaps` 스키마 변경 + boltz vendored 복사(F8 드리프트)가 필요하고 영향이 sub-sat라
  over-engineering. submarine 크래시복구 예산도 동일 수용(희귀, ≥dust 결제).

---

## M2 — `pay_invoice` payment_hash dedupe 부재 [MEDIUM] ✅

**원인:** LN이 이중 settle을 막아 수취인은 두 번 안 받지만, 클라 타임아웃 재시도 시 새 스왑을
또 펀딩 → swap fee 2회 + 자금 72h(T) 락.

**수정:** `pay_invoice.ts` 선두에서
- 이미 settled된 같은 payment_hash → 저장된 preimage 재반환 (재펀딩 안 함),
- 같은 해시가 이 커넥션에서 pending(진행 중) → `QUOTA/OTHER` 거부.

---

## M3 — 받기 settled를 boltz 말만 믿음 + 영수증 위변조 [MEDIUM] ✅

**원인:** reverse swap이 `settled`라면 boltz status만으로 `transactions`를 settled로 기록하고
CLINK 9735 영수증을 발행. boltz가 "성공"을 거짓 보고하면 받지도 않은 금액으로 기록/영수증.

**수정 (`boltz.ts`):**
- `confirmReverseLanded(wallet, expected)` — SDK wallet view(arkd 인덱서로부터)에서 대략
  착지액만큼의 vtxo가 보이는지 제한 폴링(최대 ~4s). boltz 말이 아닌 **Ark 착지**로 판정.
- `onSwapCompleted` reverse 분기: 착지 확인 전엔 settled 기록/영수증 보류(로그+DM), 후속
  reconcile pass가 확인되면 처리(자가 치유 — 영구 pending 없음).
- `reconcilePendingIncoming` settled 분기 동일 게이트.
- `clink/offers.ts` `reconcileClinkAcks` ≥dust 영수증 분기도 `wallet`을 받아 동일 게이트.

**❗ 리뷰 한계 (R3, 2차 수정 해소):** 값-근사 매칭만으론 기존 동일액 vtxo(반복 21·100·1000 sat zap)에
오탐. **해소:** `confirmReverseLanded`에 `sinceMs` 파라미터 추가 — `VirtualCoin.createdAt ≥ 스왑 생성
시각`(`BoltzReverseSwap.createdAt`, unix sec) 필터. 같은 액수 반복 zap 2번째를 boltz가 거짓 보고해도
1번째 vtxo는 createdAt이 2번째 스왑 생성보다 과거라 배제. 3개 호출부(onSwapCompleted·
reconcilePendingIncoming·reconcileClinkAcks) 모두 스왑 기준 전달.

---

## M4 — primary unroll이 잘못된 SDK `bumpP2A` 사용 [MEDIUM] 🚫 방치

자체 boost(`boost.ts`)는 `bumpP2A`를 "unusable"로 비활성화했지만, **멀티-트랜잭션 자동
unroll의 기본 경로는 여전히 그 SDK 함수를 통과**한다(미확정 코인 선택, 잔돈 dust 무검사,
에러 삼킴, RBF floor 없음). fee 급등 상황에서 중간 hop CPFP가 잘못된 fee로 나가거나
조용히 실패해 체인이 중단된다.

**방치 근거 (운영자):** "bump는 유저의 명시적 허락 아래 해야 한다"가 맞고, 잠재적 대가는
**확정 자금의 손실이 아니라 체인 중단(stuck)뿐**이다. 자동 중단 시 그 hop을 수동 boost로
진행하면 된다 — 이미 수동 boost 경로가 존재하므로 안전 범위. (개선 여지: 자동 경로를
`boost.ts` 로직으로 교체.)

---

## M5 — 단일 esplora + error-as-not-found [LOW] 🚫 방치

Unroll.Session이 esplora 읽기 실패를 "tx not found"로 해석해 이미 확정된 부모를 재브로드캐스트,
op를 failed로 만든다. **방치 근거:** 자금 손실 없음(안전), 중단 시 수동 재시작/재개로 충분.

---

## M6 — NIP-65 릴레이 목록 무제한·미검증 [LOW] ✅

**수정 (`outbox.ts`):**
- `isSafeRelayUrl(url)` 신설: ws(s) scheme만 허용, loopback/사설/링크-로컬/CGNAT/예약 IP
  리터럴 차단(호스트명 "localhost"·공용 도메인은 허용 — 로컬/dev 릴레이 유지).
- `extractTagUrls`(10002 'r'·10050 'relay' 공용)에서 `isSafeRelayUrl` 필터 + **상한 50개**.

---

## M7 — noffer 릴레이 SSRF [LOW] ✅

**원인:** `clink/send.ts`의 `requestNofferInvoice`가 붙여넣은(타인이 만든) noffer의 릴레이 URL을
scheme/호스트 검증 없이 `pool.subscribeMany`/`publish`에 그대로 사용 → 악성 noffer로 내부
ws(s) 엔드포인트로 outbound 연결/스캔 가능.

**수정:** 동일 `isSafeRelayUrl`을 noffer 릴레이에 적용 — 안전하지 않으면 `decode` 오류 반환
(연결 안 함). regtest의 로컬 릴레이는 호스트명("localhost")이라 통과되어 드릴 보존.

---

## 리뷰 검증 (2026-08-02, 외부 코드리뷰)

diff 전건(11개 파일)을 원 코드·SDK 내부 동작과 대조. typecheck clean + 473 pass / 1 skip / 0 fail
재현 확인. **판정: 원 지적 8건 전부 실재, 심각도 타당. CSRF·M2·M6·M7 수정 적정. M1 부분수정(R1·R2),
M3 게이트 한계(R3). 기능 회귀 없음.**

**신규 발견 → 상태표 R1~R4.** 상세는 M1/M3 섹션의 ❗ 정정/한계 블록 + 아래 R4.

- **R4 (CSRF 잔여, LOW):** `csrfGuard`가 POST에만 적용 — DNS-rebinding **GET 읽기**(잔액·히스토리·
  exit 목록·스왑 상태)는 여전히 가능. 클라이언트 secret은 저장 안 하고 POST `/connections` 응답에만
  노출되므로(가드됨) 자금 통제로는 못 이어짐 = 프라이버시 등급. → **해소:** `readGuard`(Host-루프백
  체크) 추가해 데이터 노출 GET 전부(`/`, `/send`, `/exit*`, `/swaps`, `/history`, `/connections*`,
  `/events`) 적용.

## R1~R4 해소 (2026-08-02, 2차 수정)

| R | 조치 | 위치 |
|---|------|------|
| R1 | `onSwapCreated` 콜백 → submarine swap 생성 직후 swap_id 기록 (크래시-창 복구) | `ln_send.ts`(LnSendDeps·sendSubmarine), `pay_invoice.ts` |
| R2 | outgoing atomic reconcile settled 전이가 spent_msat += amount_msat (changes-gated) | `boltz.ts` reconcilePendingIncoming |
| R3 | `confirmReverseLanded`에 createdAt ≥ 스왑 생성 시간 필터 | `boltz.ts`, `clink/offers.ts` |
| R4 | `readGuard`(Host-루프백)을 데이터 GET 전부에 적용 | `web/server.ts` (14개 GET) |

**반박/수용 (근거):**
- **R2 fee 미반영** 🚫 수용 — atomic_swaps에 fee 보관은 스키마 변경 + boltz vendored 복사(F8) 필요,
  영향 ≈0.5%·sub-sat. 'never' 예산 본질(손상 클라 상한)을 훼손하지 않음.
- **R1 pre-create 크래시 창** 🚫 수용 — INSERT→createSubmarineSwap 사이(마이크로초, 로컬 호출).
  이 구간 폐기 시 스왑이 생성 전이라 회수할 것도 없고(M2 재시도 불능만), 30s reconcile이 이 창을
  실시간으로 쓸면 라이브 send와 레이스 — sweep하지 않음이 안전.
- **R2 submarine 크래시복구 예산** 🚫 수용 — 희귀(≥dust 결제) + atomic과 달리 `syncSwapToDb` 경유.

**재검증 (2차, 외부 코드리뷰): R1~R4 전건 해소 확인 ✅.** typecheck clean + 480 pass / 1 skip /
0 fail 재현. 검증 근거:
- R1: `onSwapCreated`가 `createSubmarineSwap` 직후·settle 대기 전 발화, UPDATE는 `state='pending'`
  gate — 크래시 후 resume→`syncSwapToDb` 매칭 성립(성공·실패 양 경로). 수용한 pre-create 창도 타당
  (단, "마이크로초·로컬 호출"은 약간 관대한 서술 — 창이 boltz HTTP create 왕복을 포함. throw는
  handler catch가 failed 처리하므로 실제 노출은 그 호출 중 hard-kill뿐).
- R2: changes-gate로 재진입 pass 이중가산 불가, connection 서브쿼리 정확, 테스트가 카운터 21000
  착지 검증. 수용 2건(fee·submarine 경유)의 근거 성립.
- R3: 3개 호출부 모두 `swapCreatedMs` 전달, fail-safe 방향(vtxo createdAt 결측→defer, swap
  createdAt 결측→필터 off=구 동작), sec/ms 휴리스틱이 upstream 드리프트 방어.
- R4: GET 14/14 가드(SSE `/events` 포함), fallback fetch 핸들러 없음(미매칭=Bun 기본 404),
  POST 18/18 유지.
- 2차 수정발(發) 신규 회귀 없음: pay_invoice deps 명시 전달 누락 없음(typecheck), `/setup` GET
  가드는 로컬 플로우 무영향, M3 defer DM은 이벤트 콜백 1회성(reconcile defer는 로그만 — 스팸 없음).

잔여 nit (비차단) — **전건 후속 처리 완료(같은 커밋, 482 pass 재green)**:
- ~~R3 필터 자체의 단위 테스트 부재~~ → `boltz_reconcile.test.ts`에 2종 추가: 과거 동일액 vtxo는
  defer(오탐 차단), 스왑 이후 생성 vtxo는 settle.
- ~~신규 M1/R2 테스트 3종의 `reconcilePendingIncoming` await 누락~~ → `await` 부착.
- ~~R2 settled flip + 카운터 bump 2문 `db.transaction` 미포장~~ → 포장(핸들러 settle과 동일 불변식).
- ~~`web/server.ts` `},      },` 포매팅 오타~~ → 수정.

**회귀 없음 확인 목록 (지킬 것):**
- M3 deferral 안전성: SDK가 repo `saveSwap` **후** 완료 이벤트 발화 → deferred swap은 boltz_swaps에
  terminal로 남아 reconcile이 반드시 회수. 만료 sweeper는 `swap_id IS NULL` 스코프(`ln_receive.ts`)라
  deferred row를 'expired'로 못 죽임. incoming row는 생성 시 swap_id 기록(`make_invoice.ts`).
- F19 상호작용: 새 M1 outgoing pass는 atomic **터미널** 상태에서만 transactions를 건드림 — 라이브
  send row 침범/예산 이중 계상 없음.
- M6 정규화: extractTagUrls 출력 정규화는 소비자 재정규화(멱등)와 정합. WHATWG URL이 진수 IP 표기
  (`ws://2130706433` 등)를 canonicalize한 뒤 차단 → 리터럴 우회 없음.
- CSRF 오차단 없음: compose `127.0.0.1:4282:4282` 동일 포트라 Origin 포트 검사 정합. sandboxed-iframe
  `Origin: null`(문자열)은 URL 파싱 실패로 거부(올바름). 상태 변경 GET 핸들러 없음(전수 확인).

**사소 (비차단, 정리 시):**
- `onSwapCompleted`가 async가 되면서 SDK는 await 없이 호출 — `syncSwapToDb` throw 시 unhandled
  rejection(Bun은 로그만). confirm 내부 catch는 있음.
- M2 in-flight 체크는 커넥션 단위 — 교차-커넥션 동시 같은 인보이스 submarine 이중 펀딩 가능
  (sub-dust는 `payment_hash UNIQUE`로 차단, 솔로 운영이라 수용 가능). settled replay는 교차-커넥션
  preimage 반환(예산 미과금) — 동일 사유로 수용.
- `web/server.ts:1006` `},      },` 포매팅 오타. → nit 처리로 수정됨(§재검증).
- 드릴 주의: 로컬 relay는 `ws://localhost:…`로 — `ws://127.0.0.1:…` 리터럴은 M6 필터에 차단됨
  (bootstrap 릴레이는 필터 비대상이라 테스트는 통과한 것).

## 검증 시 OK (회귀로 지킬 것)

- **evidence-gated GC** (`evidence.ts`/`proof_sync.ts`): spent-verified(우리 키 schnorr) /
  value-conservation(absorption) / expired; 미확인은 quarantine(증명 보존). 서버가 서명 없이
  "사라졌다" 해도 탈출재료를 못 지움. vtxo 만료는 MAX로만 단조 갱신.
- **final send 목적지 검증** (`dest.ts`/`dest_verify.ts`/`final_send.ts`): challenge에
  address+nonce 임베드 → 재바인딩/replay 불가, 재발급 시 verified_at=NULL(TOCTOU 없음),
  BIP-322 simple + legacy recoverable-ECDSA 상수시간 검증, 오직 검증 dest만 대상.
- **atomic 스왑 돈-안전** (`script.ts`/`split.ts`/`send.ts`): 4-leaf 공유 스크립트, claim은
  F 사전서명으로 a+fee만, change는 후더 복귀, refund가 전액 V 회수. boltz는 a+fee 이상 못
  가져감; verify-before-bookkeep(claim spent / refund registered)이 양쪽 게이트.
- **예산 동시성**, **SQL 주입 전무(전부 파라미터화)**, **커넥션 간 격리**(lookup/
  list_transactions connection_id 필터), **history keyset 페이지네이션** — OK.

## 테스트

- `bun run typecheck` — clean.
- `bun test test/unit test/nostr test/integration` — **482 pass / 1 skip / 0 fail**.
  (M3로 바뀐 `boltz_reconcile.test.ts` + 신규: "success-but-no-Ark-vtxo는 defer(M3)",
  **R3 createdAt 필터 2종**(과거 동일액 vtxo defer / 이후 생성 settle),
  **M1/R2 outgoing reconcile 3종**(claimed→settled+budget / refunded→failed / in-flight 보존),
  **M6/M7 `isSafeRelayUrl` 4종** 포함; `ln_send.test.ts`는 swapId 반영.)
- 실스택 regtest 드릴(`regtest-atomic.sh`)은 미실행 — M6/M7의 설정/릴레이 영향은 다음 드릴에서
  재확인 권장(특히 noffer·outbox 릴레이 경로).
- ⚠️ (리뷰) 재발방지 테스트 갭 잔여: 레포 관례(F1~F18 각 건 테스트)와 달리 **CSRF `csrfGuard`·
  M2 `pay_invoice` dedupe**는 아직 단위 테스트 없음 (web/pay_invoice 핸들러 하니스 필요). M1/M6/M7·
  M3·R3은 커버됨. R1·R2 수정 반영으로 앞서 0건이던 M1·M6·M7이, nit 처리로 R3 필터 2종이 추가됨.
