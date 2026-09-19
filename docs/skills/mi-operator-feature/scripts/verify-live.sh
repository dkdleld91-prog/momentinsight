#!/bin/bash
# 라이브 화면 확인: bash verify-live.sh <marker> [marker...]  — 실제 admin/client HTML 에 표식이 있는지 센다
a=$(curl -s -m 25 https://insight.momentlabs.co.kr/admin); c=$(curl -s -m 25 https://insight.momentlabs.co.kr/client)
curl -s -m 15 https://insight.momentlabs.co.kr/health | grep -o '"release":"[^"]*"'
for k in "$@"; do printf "%-36s admin=%s client=%s\n" "$k" "$(printf '%s' "$a" | grep -c -- "$k")" "$(printf '%s' "$c" | grep -c -- "$k")"; done
