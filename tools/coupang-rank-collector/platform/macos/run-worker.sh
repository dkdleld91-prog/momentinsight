#!/bin/zsh
# C 30일 순위(쿠팡) 수집기 launchd 래퍼(명세 §9.6.4). 연결 코드는 키체인에서 이 프로세스에만 넘기고, node 가 시작 즉시 지운다.
set -euo pipefail
umask 077
ROOT="${0:A:h:h}"
NODE="$(<"$ROOT/node-path")"
ACCOUNT="$(/usr/bin/id -un)"
if ! TOKEN="$(/usr/bin/security find-generic-password -s co.kr.momentinsight.coupang-rank-collector -a "$ACCOUNT" -w 2>/dev/null)"; then
  print -r -- "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ') token_missing" >> "$ROOT/logs/worker.log"
  exit 0
fi
MI_COUPANG_COLLECTOR_TOKEN="$TOKEN" exec "$NODE" "$ROOT/app/worker.mjs"
