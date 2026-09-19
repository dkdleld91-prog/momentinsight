#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""잠금 갱신: python3 lock-regen.py <worktree> [id=migration.sql ...]  (새 순위 마이그레이션은 id=파일 로 등록)"""
import sys, json, hashlib, subprocess
W = sys.argv[1]
cur = json.loads(subprocess.run(["node", "scripts/check-protected-rank-features.mjs", "--print-current"], cwd=W, capture_output=True, text=True, check=True).stdout)
lock = json.load(open(f"{W}/scripts/protected-rank-features.lock.json", encoding="utf-8"))
for arg in sys.argv[2:]:
    mid, mig = arg.split("=", 1)
    sha = hashlib.sha256(open(f"{W}/{mig}", "rb").read()).hexdigest()
    hit = [e for e in cur["files"] if e.get("file") == mig]
    if hit: hit[0]["sha256"] = sha
    else: cur["files"].append({"id": mid, "file": mig, "sha256": sha, "rankMigration": True})
for key in ("version", "baselineCommit", "policy", "n30Freeze"):
    if key in lock and key not in cur: cur[key] = lock[key]
with open(f"{W}/scripts/protected-rank-features.lock.json", "w", encoding="utf-8") as f:
    json.dump(cur, f, ensure_ascii=False, indent=2); f.write("\n")
print(subprocess.run(["node", "scripts/check-protected-rank-features.mjs"], cwd=W, capture_output=True, text=True).stdout.strip().split("\n")[-1])
