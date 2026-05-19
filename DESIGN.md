# arkade-nwc-bridge — 초기 설계 문서

> 이 문서는 프로젝트 초기 설계의 스냅샷이다. 구현 도중 결정이 바뀌면
> 그 시점에 이 문서를 갱신한다. 코드보다 _왜 이렇게 결정했는지_ 를
> 기록하는 데 무게를 둔다.

## 1. 목적

[NIP-47 (Nostr Wallet Connect)](nips/47.md) 의 **wallet service** 를 구현한다.
nostr 클라이언트가 라이트닝 결제/수신을 하려고 보내는 NWC 요청을
받아서, [Ark Protocol](ts-sdk/README.md) 지갑을 통해 실제로 처리해주는
**브릿지 서버** 다.

라이트닝은 [Boltz](https://docs.boltz.exchange) 의 submarine swap / reverse
swap 을 이용해 Ark 지갑 측에서 송수신한다. Ark 클라이언트
구현(`wallet/`) 이 동일한 메커니즘을 쓰고 있으므로 그 경로를 그대로
재사용한다.

## 2. 사용자

라이트닝 노드를 운영하기는 부담스럽지만 24시간 켜둔 서버 한 대 정도는
가지고 있고, 셀프 커스토디얼 라이트닝 월렛을 원하는 사람.

주된 활용 케이스는 **nostr 클라이언트에 NWC 로 붙여 zap 을 보내는 것** 이다.
zap 수령은 부차적 (make_invoice 는 지원하지만 active notification 은 안 함).

## 3. 핵심 결정

| 결정 | 값 | 이유 |
|---|---|---|
| 네트워크 | **mainnet** | 다른 nostr 클라이언트들이 메인넷 위주라 테스트가 어려움. 소액으로만 운용. |
| 런타임 | **Bun** (TypeScript) | `package.json` 이 이미 bun 베이스. sqlite 도 `bun:sqlite` 로 zero-dep. |
| 프론트엔드 | **Bun.serve + 서버 렌더 HTML** | 화면이 적고(`/`, `/connections`, `/history`) 별도 빌드 파이프라인 둘 가치가 없음. |
| 저장소 | **SQLite** (`bun:sqlite`) | 파일 하나, 첫 기동에 자동 생성. |
| Ark 키 표현 | **`nsec` 한 줄** (`.env` 평문) | wallet/ 의 백업키와 동일 표현. Amber 등 nostr 도구와 백업 호환. 니모닉은 결국 단일 키만 derive 하므로 (`m/44/1237/0'/0/0` 고정) 의미 없음. |
| 시크릿 보관 | `.env` 평문 | 로컬-only PoC. OS keystore / 암호화 keyfile 은 phase 2 (NWC 메서드 완성 후). |
| Remote signer 위임 | **하지 않음** | NIP-46 은 `sign_event` 만 노출 — Ark 의 PSBT/MuSig2 서명은 위임 불가. Amber 등 통한 nsec 외부화는 표준 변경 전까지 막혀 있음. |
| VTXO 갱신 위임 (delegation) | **하지 않음** (브릿지가 24/7 가동 전제) | `delegatorProvider` 를 켜면 offchain tapscript 에 delegation path 가 추가되어 *같은 키여도 다른 ark 주소* 가 생성됨. arkade.money 는 default 가 ON 이므로 같은 nsec 로 import 해도 잔고가 안 보임 — arkade.money 쪽에서 delegate 를 끄거나 별개 계정으로 운용해야 함. |
| 연결별 키 | **커넥션마다 새 service keypair** | NIP-47 권장사항. 결제 활동을 사용자 메인키와 연결하지 않기 위함. Ark 키와는 완전 별개. |
| Notifications | **미구현, info 에서도 광고 안 함** | zap 발송은 응답 이벤트로 충분. 수령 알림은 추후 고도화. |
| HTTP 노출 | **`127.0.0.1` 바인딩, 인증 없음** | 외부와의 통신은 모두 nostr relay 를 통한 아웃바운드. 인바운드 자체가 없음. reverse proxy / auth 불필요. |

## 4. 아키텍처

```
┌──────────────────────────────────────────────────────┐
│ Web UI  (Bun.serve + 서버 렌더 HTML, 127.0.0.1만)    │
│   /, /connections (new/list/revoke), /history       │
├──────────────────────────────────────────────────────┤
│ Nostr Service  (SimplePool, 13194/23194/23195)      │
│   subscribe → decrypt → handler → encrypt → publish │
├──────────────────────────────────────────────────────┤
│ Handlers    │ Background Workers                    │
│  get_info   │  reverse-swap claim watcher           │
│  get_balance│  submarine-swap refund/timeout        │
│  make_invoice│                                      │
│  pay_invoice │                                      │
├──────────────────────────────────────────────────────┤
│ Wallet Layer   (@arkade-os/sdk + @arkade-os/boltz)  │
│ Storage Layer  (bun:sqlite)                         │
└──────────────────────────────────────────────────────┘
```

외부 의존:

- **ASP (Ark Service Provider)** — `https://arkade.computer` (mainnet 기본)
- **Boltz mainnet API** — `https://api.boltz.exchange`
- **nostr relay(s)** — env 로 설정 (기본은 알비 / damus 등 공개 relay)

모두 아웃바운드 호출. 인바운드 포트 없음 (HTTP 는 로컬 전용).

## 5. 디렉터리 레이아웃

```
src/
  config.ts          // .env 파싱, 네트워크/relays/nsec
  db.ts              // bun:sqlite 초기화 + 마이그레이션
  wallet.ts          // nsec → SingleKey identity + Wallet + boltz client 부트스트랩
  nostr/
    service.ts       // pool, info event 발행, 요청 구독, 디스패치
    crypto.ts        // nip44/nip04 추상화 + 라우팅
  handlers/
    get_info.ts
    get_balance.ts
    make_invoice.ts  // Boltz reverse swap
    pay_invoice.ts   // Boltz submarine swap
  workers/
    reverse_claim.ts // 대기 중인 reverse swap 의 VHTLC claim
    submarine_refund.ts // 실패한 submarine swap refund
  web/
    server.ts        // Bun.serve 라우터
    views/*.ts       // HTML 템플릿(태그드 템플릿)
    qr.ts            // qr 생성
  lib/
    msat.ts          // msat <-> sat 변환 + 라운딩 정책
    errors.ts        // NIP-47 에러 코드 매핑
  index.ts           // 부트스트랩
```

## 6. SQLite 스키마

```sql
-- 각 NWC 클라이언트별 커넥션. 서비스 키페어는 커넥션마다 새로 생성.
connections (
  id INTEGER PRIMARY KEY,
  label TEXT,                          -- 사용자가 식별 위해 붙이는 이름
  service_secret_hex TEXT NOT NULL,    -- 우리쪽 키. 응답 서명/암호화에 사용
  service_pubkey_hex TEXT NOT NULL,    -- info event/응답 발행 시 author
  client_pubkey_hex TEXT NOT NULL,     -- request.pubkey 검증용
  -- 참고: client_secret 은 URI 만들 때만 알면 됨. 저장 안 함 (NIP 권장).
  budget_msat INTEGER,                 -- nullable = 무제한
  spent_msat INTEGER DEFAULT 0,
  expires_at INTEGER,                  -- nullable
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- pay_invoice 요청 (outgoing). swap = boltz submarine.
payments (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER REFERENCES connections(id),
  request_event_id TEXT UNIQUE,        -- 리플레이 방지
  invoice TEXT NOT NULL,
  payment_hash TEXT NOT NULL,
  amount_msat INTEGER NOT NULL,
  fees_paid_msat INTEGER,
  swap_id TEXT,                        -- boltz submarine swap id
  state TEXT NOT NULL,                 -- pending | settled | failed | refunded
  preimage TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

-- make_invoice 요청 (incoming). swap = boltz reverse.
invoices (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER REFERENCES connections(id),
  request_event_id TEXT UNIQUE,
  invoice TEXT NOT NULL,
  payment_hash TEXT NOT NULL,
  amount_msat INTEGER NOT NULL,
  description TEXT,
  swap_id TEXT,
  state TEXT NOT NULL,                 -- pending | accepted | settled | expired | failed
  preimage TEXT,
  claimed_txid TEXT,                   -- VHTLC claim 결과
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  settled_at INTEGER
);

-- 처리된 NWC request event id 캐시 (리플레이 방지/감사).
processed_events (
  event_id TEXT PRIMARY KEY,
  connection_id INTEGER,
  method TEXT,
  processed_at INTEGER
);
```

## 7. NWC 메서드별 흐름

### `get_info` (필수)

capabilities 응답. info event(kind 13194) 는 startup 및 커넥션 생성 시
replaceable 로 별도 발행. content 는 `"get_info get_balance make_invoice pay_invoice"`.
`encryption` 태그에 `nip44_v2 nip04` 표기. **`notifications` 태그는
포함하지 않는다** (광고하지 않음).

### `get_balance`

`wallet.getBalance().available` → ×1000 (msat) 으로 반환.

### `make_invoice` (LN → Ark)

1. `params.amount` (msat) → sat 변환. 1000 으로 안 나눠지면 NIP-47 `OTHER`.
2. `arkadeSwaps.createReverseSwap({ amount, description })` → BOLT11 수신.
3. `invoices` 테이블에 `pending` 으로 저장. NWC 응답으로 invoice 즉시 반환.
4. **background `reverse_claim`** 워커가 swap state 폴링.
5. 사용자가 BOLT11 결제 → VHTLC 가 우리 swap 주소로 도착 → `claimVHTLC(swap)` → `state=settled`.

알림은 발송하지 않음 (클라이언트가 `lookup_invoice` 폴링해야 결과를 알 수 있음 — MVP 이후 추가 예정).

### `pay_invoice` (Ark → LN)

1. invoice decode (`light-bolt11-decoder`) — amount/payment_hash 추출.
2. 커넥션 `budget_msat` 체크, 예약된 `spent_msat` 증가.
3. `arkadeSwaps.createSubmarineSwap({ invoice })` → swap address + 예상 금액.
4. `sendOffChain` 으로 swap address 에 VTXO 전송.
5. `arkadeSwaps.waitForSwapSettlement(swap)` → preimage 수신.
6. NWC 응답으로 preimage 반환, `payments.state=settled`.
7. 실패 시 `refundVHTLC(swap)` 시도 + NWC 에러 `PAYMENT_FAILED`. 예약했던 `spent_msat` 롤백.

## 8. `.env` 형식

```dotenv
ARK_NSEC="nsec1..."                      # Arkade Wallet 의 백업키 그대로 import 가능
ARK_SERVER_URL="https://arkade.computer"
BOLTZ_URL="https://api.boltz.exchange"
NETWORK="bitcoin"
NWC_RELAYS="wss://relay.getalby.com/v1,wss://relay.damus.io"
HTTP_PORT=4282
HTTP_BIND="127.0.0.1"
DB_PATH="./data/bridge.sqlite"
```

`.env.example` 을 함께 둔다.

## 9. 구현 순서

작은 단위로 e2e 가 동작하는 방향으로 쌓는다.

1. **Skeleton** — deps 추가 (`@arkade-os/sdk`, `@arkade-os/boltz-swap`,
   `nostr-tools`, `light-bolt11-decoder`, `eventsource` 폴리필, `qr`),
   `.env` 로딩, 빈 부트스트랩.
2. **DB & 마이그레이션** — 위 스키마, 첫 기동 시 파일 생성.
3. **Wallet bootstrap** — 잔고 조회되는지 CLI 한 번 확인.
4. **Boltz-swap Node 호환 확인** — `ServiceWorkerArkadeSwaps` 는 브라우저용.
   Node 에서 동작하는 클래스가 무엇인지 install 후 확인. 안 되면 (a) raw
   HTTP 로 Boltz REST 직접 호출 + (b) VHTLC 는 ts-sdk 의 `vhtlc` 모듈로
   처리하는 식으로 우회.
5. **Nostr layer** — info event 발행, 23194 구독, 디크립트, 디스패치 +
   `get_info` `get_balance` 처리. 여기서 첫 e2e 검증.
6. **`make_invoice`** + reverse-claim 워커.
7. **`pay_invoice`** + refund 처리.
8. **Web UI** — `/`, `/connections` 목록/생성/취소 (URI + QR).
9. **이력 페이지** — payments/invoices 노출.
10. **마무리** — NIP-47 에러 코드 매핑 점검, `expiration` 태그 처리,
    그레이스풀 셧다운.

## 10. 알려진 리스크 / 미해결

- **boltz-swap Node 호환**: `wallet/` 이 쓰는 `ServiceWorkerArkadeSwaps` 는
  브라우저 SW 전용. 패키지 안의 다른 export (`SwapManagerClient` 등) 가
  헤드리스에서 쓰일 수 있는지 install 후 살펴봐야 함. 4번 단계에서 결정.
- **Reverse swap 알림 부재**: `make_invoice` 후 결제 수령은 `lookup_invoice`
  폴링으로만 알 수 있음. 일부 클라이언트는 폴링을 안 함 — 추후 23197
  notification 구현 필요.
- **mainnet 자금**: 소액이라 해도 실수금. boltz/asp 둘 다 알파 단계.
  키 노출 시 손실 가능 — `.env` 파일 권한 관리 / 백업 주의.
- **VTXO 만료**: Ark 의 vtxo 는 만료가 있음. `wallet.create` 의 기본
  `settlementConfig` (3일 임계로 자동 renew) 를 그대로 쓴다. 단, 브릿지가
  꺼져 있으면 renew 가 안 됨 — 24/7 가동 전제 위반 시 데이터 손실 위험.
- **Remote signer (NIP-46/Amber) 위임 불가 — 검토 완료, 폐기**:
  - Ark Identity 는 3가지 서명을 요구: 임의 메시지 schnorr (`signMessage`),
    PSBT 입력 (`sign`, BIP-341 sighash), MuSig2 트리 서명 (`signerSession`,
    인터랙티브 멀티 라운드).
  - NIP-46 표준 메서드는 `sign_event` 뿐 — 입력이 nostr event JSON 으로
    강제되어 임의 32바이트 해시 서명을 끌어낼 수 없음. raw schnorr / MuSig2
    라운드 메서드는 표준에 없음.
  - 따라서 "Amber 에 위임해서 .env 에서 nsec 빼기" 는 현 시점 불가능.
    NIP-46 이 raw 서명을 표준화하더라도 MuSig2 인터랙티브 라운드는 별도
    프로토콜이 필요 — phase 2 후보에서 제외.
  - 더 현실적인 키 격리 경로 (필요해질 때): OS keystore (Keychain/libsecret),
    부팅 시 패스프레이즈로 unlock 되는 암호화 keyfile, 별도 머신의 signer
    데몬. 일단은 모두 미루고 `.env` 평문으로 간다.
