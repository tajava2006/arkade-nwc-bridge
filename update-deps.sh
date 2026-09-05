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
# boltz-swap이 sdk 핀을 올렸을 때만 overrides 네 줄을 손으로 올릴 것:
echo "-- ark 커플링 확인 (아래 두 줄이 같아야 함)"
echo "   boltz-swap이 요구하는 sdk: $(node -e "console.log(require('./node_modules/@arkade-os/boltz-swap/package.json').dependencies['@arkade-os/sdk'])")"
echo "   overrides가 강제하는 sdk : $(node -e "console.log(require('./package.json').overrides['@arkade-os/sdk'])")"

echo "== 타입체크 =="
bun run typecheck

echo "== 테스트 =="
bun run test

echo ""
echo "⚠️ @arkade-os/* 는 pre-1.0 — minor에도 breaking 가능."
echo "   운영 배포 전 mainnet 스모크(잔고 조회 + 소액 송금 1회) 할 것."
