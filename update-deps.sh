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

echo "== 타입체크 =="
bun run typecheck

echo "== 테스트 =="
bun run test

echo ""
echo "⚠️ @arkade-os/* 는 pre-1.0 — minor에도 breaking 가능."
echo "   운영 배포 전 mainnet 스모크(잔고 조회 + 소액 송금 1회) 할 것."
