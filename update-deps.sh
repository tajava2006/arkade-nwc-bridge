#!/usr/bin/env bash
# 의존성 한방 최신화 (주기 실행)
#
# 이 앱은 아무도 라이브러리로 가져다 쓰지 않는 최말단이라, 버전을 붙잡고 있을 이유가 없다.
# 항상 latest를 따라가고 깨지면 그때 고치는 게, 몇 달치 breaking을 한꺼번에 맞는 것보다 싸다.
# 개별 패키지를 나열하지 않는 것도 같은 이유 — 새 의존성이 추가돼도 목록 갱신을 잊을 일이 없다.
set -euo pipefail
cd "$(dirname "$0")"

echo "== JS 의존성 (전부 latest) =="
bun update --latest

# package.json의 `overrides`가 ark 커플링을 지킨다: @arkade-os/boltz-swap은 @arkade-os/sdk를
# 정확한 버전으로 핀하고, 그 sdk는 다시 @noble/curves·@scure/*를 정확한 버전으로 핀한다.
# 우리가 그보다 앞서 나가면 트리에 같은 라이브러리가 두 벌 생기고, 타입 정체성이 갈려
# 컴파일이 깨진다(운 나쁘면 런타임에 조용히 갈린다). --latest는 dependencies는 밀지만
# overrides는 안 건드리므로 해소는 유지된다.
# ⚠️ overrides는 완전히 조용하다. 어긋난 값을 강제해도 bun install은 경고 한 줄 없고,
# tsc도 통과하고, 테스트 564개도 전부 통과한다 — 트리에 두 벌이 깔린 채로 (2026-09-05 실측).
# 그러니 "언젠가 실패가 나서 알아차리겠지"는 성립하지 않는다. 여기서 직접 대조한다:
# 우리가 강제하는 값 vs ark 패키지가 실제로 선언한 값. 어긋나면 빌드 전에 멈춘다.
echo "== ark 커플링 검사 =="
node - <<'JS'
const ours = require('./package.json').overrides || {}
const claims = {} // name -> [{owner, range}]
for (const owner of ['@arkade-os/boltz-swap', '@arkade-os/sdk']) {
  let deps
  try {
    deps = require(`./node_modules/${owner}/package.json`).dependencies || {}
  } catch {
    continue // 아직 설치 전이거나 의존에서 빠졌으면 건너뛴다
  }
  for (const [name, range] of Object.entries(deps)) {
    if (name in ours) (claims[name] ??= []).push({ owner, range })
  }
}

const problems = []
for (const [name, forced] of Object.entries(ours)) {
  const declared = claims[name]
  if (!declared) {
    problems.push(`${name}: override가 ${forced}인데 이걸 핀하는 ark 패키지가 이제 없다 (override가 불필요해졌는지 확인)`)
    continue
  }
  for (const { owner, range } of declared) {
    if (range !== forced) {
      problems.push(`${name}: ${owner}는 ${range}를 요구하는데 override는 ${forced}`)
    }
  }
}

if (problems.length > 0) {
  console.error('\nark 커플링이 어긋났다. package.json의 overrides를 손으로 맞출 것:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\n방치하면 같은 라이브러리가 두 벌 깔린 채 조용히 빌드된다.')
  console.error('(운이 좋으면 tsc가 Wallet vs IWallet으로 잡고, 나쁘면 서명 경로에서 값이 갈린다.)')
  process.exit(1)
}
console.log(`   ok — override ${Object.keys(ours).length}개 전부 ark 패키지의 선언과 일치`)
JS

echo "== 타입체크 =="
bun run typecheck

echo "== 테스트 =="
bun run test

echo ""
echo "⚠️ @arkade-os/* 는 pre-1.0 — minor에도 breaking 가능."
echo "   운영 배포 전 mainnet 스모크(잔고 조회 + 소액 송금 1회) 할 것."
