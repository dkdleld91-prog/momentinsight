#!/bin/bash
# 전체 검사: bash pipeline.sh <worktree>  → 요약만 출력(로그는 <worktree>/../pipeline.log)
W="$1"; cd "$W" || exit 2; L="$W/../pipeline.log"
GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=y npm run check:vercel-deploy > "$L" 2>&1; echo "deploy-check exit=$?"
git diff --check; echo "diff-check exit=$?"
node scripts/check-protected-rank-features.mjs | tail -1
grep -E "^ℹ (tests|pass|fail)" "$L" | tr '\n' ' '; echo
grep -E "^✖|baseline failed|^FAIL |BLOCK" "$L" | sort -u | head -10
echo "참고: 워치독 F2·F13 실패 + collection_active 문구면 이 맥이 수집 중이라 생긴 가짜 실패 → 재실행"
