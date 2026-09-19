#!/bin/bash
# 대표 실행용 SQL 준비: bash stage-sql.sh <sql파일> <바탕화면이름.txt>  → 바탕화면 복사 + TextEdit 열기
cp "$1" "$HOME/Desktop/$2" && open -a TextEdit "$HOME/Desktop/$2" && echo "준비됨: ~/Desktop/$2 ($(wc -l < "$HOME/Desktop/$2" | tr -d ' ')줄, begin/commit $(grep -c -i -E '^(begin|commit);' "$HOME/Desktop/$2")개) — Supabase SQL 편집기용"
