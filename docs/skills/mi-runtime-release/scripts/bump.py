#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""N30 런타임 버전 인상 자동화.
사용: python3 bump.py <worktree> <새버전 예 1.1.33> <slug 예 finite_cross_page> [--summary "한 줄 요약"] [--header-file f] [--behaviour-file f]
전제: 수집기·워커·계약 코드 수정과 그 테스트를 먼저 끝낸 깨끗한 워크트리. 실패하면 `git checkout -- . && git clean -fd supabase scripts` 로 되돌린다.
하는 일: 버전 리터럴 5곳 → 지문 계산 → 감사 2개 → 정체 핀 마이그레이션 → 새 테스트 생성·직전 테스트 보관 → package.json → 라이브 표면 테스트 8개 → baseline·contract 핀 → RUNBOOK."""
import sys, re, glob, os, subprocess, datetime
args = sys.argv[1:]
def opt(name, default=None):
    if name in args:
        i = args.index(name); v = args[i + 1]; del args[i:i + 2]; return v
    return default
summary = opt("--summary", "요약을 적어주세요"); header_file = opt("--header-file"); behaviour_file = opt("--behaviour-file")
W, NEW, SLUG = args[0], args[1], args[2]
def rd(p): return open(f"{W}/{p}", encoding="utf-8").read()
def wr(p, s): open(f"{W}/{p}", "w", encoding="utf-8").write(s)
OLD = re.search(r'"version": "(\d+\.\d+\.\d+)"', rd("tools/naver-shopping-chrome-extension/manifest.json")).group(1)
major, minor, patch = OLD.split("."); PREV = f"{major}.{minor}.{int(patch) - 1}"
assert NEW == f"{major}.{minor}.{int(patch) + 1}", f"새 버전은 {major}.{minor}.{int(patch) + 1} 이어야 합니다(현재 {OLD})"
tag = lambda v: v.replace(".", ""); us = lambda v: v.replace(".", "_"); rx = lambda v: v.replace(".", "\\.")
tO, tN, tP = tag(OLD), tag(NEW), tag(PREV)
B, C = "scripts/check-release-baseline.mjs", "scripts/check-server-contract.mjs"
FP_OLD = re.search(r'"([0-9a-f]{64})"', rd("scripts/naver-shopping-candidate-performance-audit.mjs")).group(1)
FP_PREV = re.search(rf'const shoppingWorkerRuntime{tP}Fingerprint =\s*"([0-9a-f]{{64}})";', rd(B)).group(1)
MIG_OLD = os.path.basename(glob.glob(f"{W}/supabase/migrations/*_naver_shopping_runtime_{us(OLD)}_*.sql")[0])
stamps = sorted(os.path.basename(p)[:14] for p in glob.glob(f"{W}/supabase/migrations/*.sql"))
now = (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).strftime("%Y%m%d%H%M%S")
stamp = now if now > stamps[-1] else str(int(stamps[-1]) + 10000)
MIG_NEW = f"{stamp}_naver_shopping_runtime_{us(NEW)}_{SLUG}.sql"
oldVar = re.search(rf'const (\w+Runtime{tO}Migration) = read\("supabase/migrations/{re.escape(MIG_OLD)}"\);', rd(B)).group(1)
newVar = f"shoppingRuntime{tN}Migration"
pending = {}
def sub(p, pairs):
    s = pending.get(p) if p in pending else rd(p)
    for old, new in pairs:
        assert s.count(old) >= 1, f"{p}: 찾을 수 없음 → {old[:80]}"
        s = s.replace(old, new)
    pending[p] = s
def flush():
    for p, s in pending.items(): wr(p, s)
    pending.clear()
def shift(text):  # PREV→OLD, OLD→NEW (버전·지문·태그), 자리표시자로 순서 보호
    text = text.replace(FP_OLD, "@@FPN@@").replace(FP_PREV, FP_OLD)
    for a, b, c in [(rx(rx(OLD)), rx(rx(PREV)), rx(rx(NEW))), (rx(OLD), rx(PREV), rx(NEW)), (us(OLD), us(PREV), us(NEW)), (OLD, PREV, NEW)]:
        text = text.replace(a, "@@NEW@@").replace(b, a).replace("@@NEW@@", c)
    return text
try:
    # 1. 버전 리터럴
    sub("tools/naver-shopping-chrome-extension/manifest.json", [(f'"version": "{OLD}"', f'"version": "{NEW}"')])
    sub("scripts/naver-shopping-local-worker.mjs", [(f'const EXPECTED_RUNTIME_VERSION = "{OLD}";', f'const EXPECTED_RUNTIME_VERSION = "{NEW}";')])
    sub("src/server/handlers/naver-shopping-local-worker.mjs", [(f'const EXPECTED_WORKER_RUNTIME_VERSION = "{OLD}";', f'const EXPECTED_WORKER_RUNTIME_VERSION = "{NEW}";')])
    sub("src/server/naver-shopping/worker-runtime-expectation.mjs", [(f'"{OLD}"', f'"{NEW}"')])
    sub("src/server/handlers/naver-rank-trackers.mjs", [(f'const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "{OLD}";', f'const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "{NEW}";')])
    flush()
    out = subprocess.run(["node", "scripts/naver-shopping-runtime-fingerprint.mjs", NEW], cwd=W, capture_output=True, text=True, check=True).stdout
    FP_NEW = re.search(r"\b([0-9a-f]{64})\b", out).group(1)
    # 2. 감사
    for p in ["scripts/naver-shopping-candidate-performance-audit.mjs", "scripts/naver-shopping-account-rank-health-audit.mjs"]:
        sub(p, [(f'"{OLD}"', f'"{NEW}"'), (FP_OLD, FP_NEW)])
    # 3. 마이그레이션(정체 핀만 이동)
    head, body = rd(f"supabase/migrations/{MIG_OLD}").split("begin;", 1)
    body = shift(body).replace("@@FPN@@", FP_NEW)
    assert PREV not in body and FP_PREV not in body, "마이그레이션에 이전 정체가 남음"
    header = open(header_file, encoding="utf-8").read().rstrip("\n") + "\n" if header_file else f"-- Runtime {NEW} ({now[:4]}-{now[4:6]}-{now[6:8]}): {summary}\n"
    header += ("-- This migration only moves the runtime identity pins: the finite-window target\n-- rows, the coordination row and the progress entry gate (the single\n-- allowlisted runtime-literal carrier, scripts/migration-runtime-literal-audit.mjs).\n"
               f"-- Apply right after the {NEW} server release is live and the coordination row\n-- is idle on {OLD} (the release itself stops the {OLD} worker at the HTTP gate).\n")
    wr(f"supabase/migrations/{MIG_NEW}", header + "begin;" + body)
    # 4. 새 테스트 + 직전 테스트 보관
    old_test = f"scripts/naver-shopping-runtime-{OLD.replace('.', '-')}-migration.test.mjs"; new_test = f"scripts/naver-shopping-runtime-{NEW.replace('.', '-')}-migration.test.mjs"
    t = rd(old_test)
    prior_line = [l for l in t.split("\n") if l.startswith("const priorMigrationName = ")][0]
    t = t.replace(f'const migrationName = "{MIG_OLD}";', "const migrationName = \"@@MIGNEW@@\";").replace(prior_line, 'const priorMigrationName = "@@PRIOR@@";')
    t = shift(t).replace("@@FPN@@", FP_NEW).replace("@@MIGNEW@@", MIG_NEW).replace("@@PRIOR@@", MIG_OLD).replace(f"|{FP_PREV[:8]}/u", f"|{FP_OLD[:8]}/u")
    d0 = t.index(f"// Runtime {NEW} ("); d1 = t.index("const root =")
    t = t[:d0] + f"// Runtime {NEW} ({now[:4]}-{now[4:6]}-{now[6:8]}): {summary}\n// The migration only moves the runtime identity pins; every other RPC stays runtime-neutral.\n\n" + t[d1:]
    b0 = t.rindex(f'\ntest("{NEW} ')
    behaviour = open(behaviour_file, encoding="utf-8").read() if behaviour_file else f'test("{NEW} runtime files carry the new identity", () => {{\n  assert.match(read("scripts/naver-shopping-local-worker.mjs"), /const EXPECTED_RUNTIME_VERSION = "{rx(NEW)}";/u);\n}});\n'
    wr(new_test, t[:b0 + 1] + behaviour)
    a = rd(old_test)
    h0 = a.index(f'test("{OLD} is the newest runtime migration'); h1 = a.index('test("migration moves only the runtime identity pins')
    a = a[:h0] + f'// Archived {now[:4]}-{now[4:6]}-{now[6:8]} (superseded by runtime {NEW}).\ntest("keeps the archived runtime {OLD} migration pinned to its historical fingerprint", () => {{\n  const runtimeMigrations = fs.readdirSync(migrationDirectory)\n    .filter((entry) => /_naver_shopping_runtime_1_1_\\d+_/u.test(entry))\n    .sort();\n  assert.ok(runtimeMigrations.includes(migrationName));\n  assert.ok(runtimeMigrations.indexOf(migrationName) < runtimeMigrations.length - 1);\n  assert.equal(NEW_RUNTIME.fingerprint, "{FP_OLD}");\n  assert.equal(typeof calculateN30RuntimeFingerprint, "function");\n}});\n\n' + a[h1:]
    l0 = a.index(f'test("live surfaces are {OLD}'); l1 = a.rindex(f'\ntest("{OLD} ') + 1
    a = a[:l0] + f'test("the archived {PREV} evidence keeps its historical identity", () => {{\n  assert.match(priorMigration, new RegExp(OLD_RUNTIME.fingerprint, "u"));\n  assert.doesNotMatch(priorMigration, /{rx(OLD)}/u);\n}});\n\n' + a[l1:]
    wr(old_test, a)
    sub("package.json", [(old_test, f"{old_test} {new_test}")])
    # 5. 라이브 표면 테스트
    sub("scripts/naver-shopping-native-host.test.mjs", [(f'assert.equal(manifest.version, "{OLD}");', f'assert.equal(manifest.version, "{NEW}");'), (f'runtimeVersion: "{OLD}",', f'runtimeVersion: "{NEW}",')])
    sub("scripts/runtime-neutral-admission-rpcs-migration.test.mjs", [(f'version: "{OLD}",', f'version: "{NEW}",'), (FP_OLD, FP_NEW), (f'["v{OLD}", EXPECTED_RUNTIME.fingerprint]', f'["v{NEW}", EXPECTED_RUNTIME.fingerprint]'), (f"EXPECTED 런타임({OLD})", f"EXPECTED 런타임({NEW})")])
    sub("scripts/naver-shopping-local-worker.test.mjs", [(f'MI_NAVER_SHOPPING_RUNTIME_VERSION: "{OLD}",', f'MI_NAVER_SHOPPING_RUNTIME_VERSION: "{NEW}",'), (f'runtimeVersion, "{OLD}");', f'runtimeVersion, "{NEW}");')])
    sub("scripts/migration-runtime-literal-audit.test.mjs", [(f'["{OLD}"]', f'["{NEW}"]')])
    sub("scripts/naver-shopping-candidate-performance-audit.test.mjs", [(f'"{OLD}"', f'"{NEW}"'), (FP_OLD, FP_NEW)])
    sub("scripts/naver-shopping-account-rank-health-audit.test.mjs", [(f'"{OLD}"', f'"{NEW}"'), (f"'{OLD}'", f"'{NEW}'")])
    sub("src/server/handlers/naver-rank-trackers.test.mjs", [(f'runtime_version: "{OLD}",', f'runtime_version: "{NEW}",')])
    sub("src/server/handlers/naver-shopping-local-worker.test.mjs", [(f'"{OLD}"', f'"{NEW}"')])
    # 6. baseline · contract
    calc = f'const shoppingWorkerRuntime{tO}Fingerprint = calculateN30RuntimeFingerprint({{\n  repositoryRoot: process.cwd(),\n  version: "{OLD}",\n}}).fingerprint;'
    lit = f'const shoppingWorkerRuntime{tO}Fingerprint =\n  "{FP_OLD}";\nconst shoppingWorkerRuntime{tN}Fingerprint = calculateN30RuntimeFingerprint({{\n  repositoryRoot: process.cwd(),\n  version: "{NEW}",\n}}).fingerprint;'
    def pins(p):
        s = pending.get(p) if p in pending else rd(p); lines = s.split("\n")
        idx = [i for i, l in enumerate(lines) if re.match(r"^\s+&& ", l) and oldVar in l]
        assert idx, f"{p}: 핀 줄 없음"
        block = "\n".join(lines[idx[0]:idx[-1] + 1])
        nb = block.replace(oldVar, newVar).replace(f"Runtime{tO}Fingerprint", "@@TN@@").replace(f"Runtime{tP}Fingerprint", f"Runtime{tO}Fingerprint").replace("@@TN@@", f"Runtime{tN}Fingerprint")
        nb = nb.replace(f"'{OLD}'", "@@VN@@").replace(f"'{PREV}'", f"'{OLD}'").replace("@@VN@@", f"'{NEW}'")
        lines[idx[-1] + 1:idx[-1] + 1] = nb.split("\n"); pending[p] = "\n".join(lines)
    pins(B); pins(C)
    common = [(calc, lit), (f'shoppingChromeManifest.version === "{OLD}"', f'shoppingChromeManifest.version === "{NEW}"'), (f'N30_TARGET_RUNTIME_VERSION = "{OLD}";', f'N30_TARGET_RUNTIME_VERSION = "{NEW}";'), (f"shoppingCandidatePerformanceAudit.includes(shoppingWorkerRuntime{tO}Fingerprint)", f"shoppingCandidatePerformanceAudit.includes(shoppingWorkerRuntime{tN}Fingerprint)")]
    sub(B, common + [(f'const {oldVar} = read("supabase/migrations/{MIG_OLD}");', f'const {oldVar} = read("supabase/migrations/{MIG_OLD}");\nconst {newVar} = read("supabase/migrations/{MIG_NEW}");'),
        (f'const EXPECTED_RUNTIME_VERSION = "{OLD}";', f'const EXPECTED_RUNTIME_VERSION = "{NEW}";'), (f'const EXPECTED_WORKER_RUNTIME_VERSION = "{OLD}";', f'const EXPECTED_WORKER_RUNTIME_VERSION = "{NEW}";'), (f'const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "{OLD}";', f'const SHOPPING_WORKER_EXPECTED_RUNTIME_VERSION = "{NEW}";'),
        (f"      .includes(shoppingWorkerRuntime{tO}Fingerprint),", f"      .includes(shoppingWorkerRuntime{tN}Fingerprint),")])
    sub(C, common + [(f'  {oldVar}: "supabase/migrations/{MIG_OLD}",', f'  {oldVar}: "supabase/migrations/{MIG_OLD}",\n  {newVar}: "supabase/migrations/{MIG_NEW}",'),
        (f'const {oldVar} = fs.readFileSync(files.{oldVar}, "utf8");', f'const {oldVar} = fs.readFileSync(files.{oldVar}, "utf8");\nconst {newVar} = fs.readFileSync(files.{newVar}, "utf8");'),
        (f'= "{rx(OLD)}";/', f'= "{rx(NEW)}";/')])
    sub("docs/RUNBOOK.md", [(f"- **버전 이력**: {OLD} (", f"- **버전 이력**: {NEW} ({now[:4]}-{now[4:6]}-{now[6:8]} 준비·배포일 별도, 마이그레이션 `{MIG_NEW}`; {summary}) / {OLD} (")])
    flush()
except Exception as error:
    print("실패:", error); print("되돌리기: git checkout -- . && git clean -fd supabase scripts"); sys.exit(1)
print(f"완료 {OLD} → {NEW}\n지문 {FP_NEW}\n마이그레이션 supabase/migrations/{MIG_NEW}\n다음: python3 lock-regen.py {W} shopping-runtime-{NEW.replace('.', '-')}-{SLUG.replace('_', '-')}=supabase/migrations/{MIG_NEW}  →  bash pipeline.sh {W}")
