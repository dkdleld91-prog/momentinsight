#!/bin/bash
# 라이브 대기: bash wait-live.sh <sha7>
for i in $(seq 1 44); do r=$(curl -s -m 15 https://insight.momentlabs.co.kr/health | grep -o '"release":"[^"]*"'); case "$r" in *"$1"*) echo "LIVE $(TZ=Asia/Seoul date +%H:%M:%S) $r"; exit 0;; esac; sleep 30; done; echo "TIMEOUT $r"; exit 1
