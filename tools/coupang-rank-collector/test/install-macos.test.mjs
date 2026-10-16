// 맥 설치기 6단계(연결 코드)와 설치 문서 실패 표 검사.
// 6단계는 설치기 원문에서 그 구간만 떼어 /usr/bin/security 를 가짜(파일에 값을 두는 스크립트)로 바꿔 zsh 로 돌린다.
// 실제 키체인·launchctl·네트워크는 쓰지 않는다. /bin/zsh 가 없으면(리눅스 빌드) 건너뛴다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { helloAuthLabel } from "../worker.mjs";
import { COLLECTOR_DIR } from "./helpers.mjs";

const INSTALLER = fs.readFileSync(path.join(COLLECTOR_DIR, "platform", "macos", "install-macos.sh"), "utf8");
const WINDOWS_INSTALLER = fs.readFileSync(path.join(COLLECTOR_DIR, "platform", "windows", "install-windows.ps1"), "utf8");
const WORKER = fs.readFileSync(path.join(COLLECTOR_DIR, "worker.mjs"), "utf8");
const SETUP_DOC = fs.readFileSync(path.join(COLLECTOR_DIR, "..", "..", "docs", "COUPANG_RANK_COLLECTOR_SETUP.md"), "utf8");
const NO_ZSH = !fs.existsSync("/bin/zsh") && "/bin/zsh 없음";
const GOOD = `mic1_${"A".repeat(20)}-_${"b".repeat(21)}`;
const INSTALL_LINE = "curl -fsSL https://insight.momentlabs.co.kr/coupang-collector/install-macos.sh -o /tmp/mi-coupang-install.sh && /bin/zsh /tmp/mi-coupang-install.sh --release abc1234";

const FAKE_SECURITY = `#!/bin/zsh
# 가짜 security: 값은 $FAKE_STORE 파일 하나. add 는 실제처럼 두 번 묻는다(여기서는 표준 입력 두 줄).
cmd="$1"; shift
print -r -- "$cmd" >> "$FAKE_CALLS"
want_w=0
for arg in "$@"; do [[ "$arg" == "-w" ]] && want_w=1; done
case "$cmd" in
  find-generic-password)
    [[ -f "$FAKE_STORE" ]] || exit 44
    (( want_w )) && print -r -- "$(<"$FAKE_STORE")"
    exit 0 ;;
  add-generic-password)
    IFS= read -r first || exit 1
    IFS= read -r second || exit 1
    [[ "$first" == "$second" ]] || exit 1
    print -rn -- "$first" > "$FAKE_STORE"
    exit 0 ;;
  delete-generic-password)
    [[ -f "$FAKE_STORE" ]] || exit 44
    /bin/rm -f "$FAKE_STORE"
    exit 0 ;;
esac
exit 2
`;

function section(pattern, label) {
  const match = INSTALLER.match(pattern);
  assert.ok(match, label);
  return match[0];
}

// 설치기 원문에서 필요한 정의와 6단계 구간만 떼어 낸 실행 파일을 만든다.
function harness(dir) {
  const fake = path.join(dir, "fake-security");
  fs.writeFileSync(fake, FAKE_SECURITY, { mode: 0o755 });
  const step6 = section(/\n# 6\. 연결 코드[\s\S]*?(?=\n# 8\. plist)/, "6단계 구간");
  const script = [
    "#!/bin/zsh",
    "set -euo pipefail",
    section(/^SERVICE=.*$/m, "SERVICE"),
    section(/^TOKEN_RE=.*$/m, "TOKEN_RE"),
    section(/^fail\(\) \{[\s\S]*?\n\}$/m, "fail()"),
    section(/^info\(\) \{[\s\S]*?\n\}$/m, "info()"),
    'RESET_TOKEN="${1:-0}"',
    'ACCOUNT="tester"',
    step6.split("/usr/bin/security").join(`"${fake}"`),
    "print -r -- STEP6_OK",
    "",
  ].join("\n");
  const file = path.join(dir, "step6.zsh");
  fs.writeFileSync(file, script);
  return file;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mi-coupang-mac-token-"));
  const file = harness(dir);
  const store = path.join(dir, "store");
  const calls = path.join(dir, "calls");
  const runStep = ({ reset = 0, pastes = [] } = {}) => {
    fs.writeFileSync(calls, "");
    const result = spawnSync("/bin/zsh", [file, String(reset)], {
      encoding: "utf8",
      input: pastes.map((value) => `${value}\n`).join(""),
      env: { PATH: "/usr/bin:/bin", HOME: dir, FAKE_STORE: store, FAKE_CALLS: calls },
      timeout: 20000,
    });
    return { ...result, calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) };
  };
  return { dir, store, runStep, stored: () => (fs.existsSync(store) ? fs.readFileSync(store, "utf8") : null) };
}

test("맥 설치기 6단계: 형식이 틀린 붙여 넣기는 키체인에 남지 않고, 같은 줄을 다시 실행하면 다시 묻는다", { skip: NO_ZSH }, () => {
  const ctx = setup();
  try {
    // 첫 설치: 클립보드의 설치 줄을 두 번 붙여 넣음 → 형식 실패, 값은 지워진다.
    const bad = ctx.runStep({ pastes: [INSTALL_LINE, INSTALL_LINE] });
    assert.equal(bad.status, 1, bad.stderr);
    assert.equal(bad.stdout.trim(), "MI_COUPANG_INSTALL_FAIL code=connection_code_invalid");
    assert.equal(ctx.stored(), null, "틀린 값이 키체인에 남음");
    assert.match(bad.stderr, /코드만 복사해 같은 줄을 다시 실행/);
    assert.ok(!bad.stdout.includes(INSTALL_LINE) && !bad.stderr.includes(INSTALL_LINE), "붙여 넣은 값을 화면에 내지 않는다");
    // 같은 줄(--reset-token 없이) 다시 실행 → 다시 묻고, 바른 코드면 통과.
    const retry = ctx.runStep({ pastes: [GOOD, GOOD] });
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.equal(retry.stdout.trim(), "STEP6_OK");
    assert.ok(retry.calls.includes("add-generic-password"), "다시 묻지 않음");
    assert.equal(ctx.stored(), GOOD);
    // 앞뒤 공백이 붙은 코드도 같은 규칙(--reset-token 으로 바꾸다 틀림 → 지워지고, 다음 실행이 다시 묻는다).
    const spaced = ctx.runStep({ reset: 1, pastes: [` ${GOOD} `, ` ${GOOD} `] });
    assert.equal(spaced.stdout.trim(), "MI_COUPANG_INSTALL_FAIL code=connection_code_invalid");
    assert.equal(ctx.stored(), null);
    const again = ctx.runStep({ pastes: [GOOD, GOOD] });
    assert.equal(again.stdout.trim(), "STEP6_OK");
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("맥 설치기 6단계: 키체인에 이미 남아 있던 틀린 값은 지우고 다시 묻는다, 맞는 값이면 묻지 않는다", { skip: NO_ZSH }, () => {
  const ctx = setup();
  try {
    // 고치기 전 설치기가 남긴 틀린 값
    fs.writeFileSync(ctx.store, INSTALL_LINE);
    const healed = ctx.runStep({ pastes: [GOOD, GOOD] });
    assert.equal(healed.stdout.trim(), "STEP6_OK", healed.stdout + healed.stderr);
    assert.deepEqual(healed.calls, ["find-generic-password", "delete-generic-password", "add-generic-password", "find-generic-password"]);
    assert.equal(ctx.stored(), GOOD);
    // 맞는 값이 있으면 묻지 않는다(업데이트는 같은 한 줄).
    const update = ctx.runStep();
    assert.equal(update.stdout.trim(), "STEP6_OK");
    assert.deepEqual(update.calls, ["find-generic-password"]);
    // --reset-token 이면 맞는 값이 있어도 다시 묻는다.
    const other = `mic1_${"z".repeat(43)}`;
    const reset = ctx.runStep({ reset: 1, pastes: [other, other] });
    assert.equal(reset.stdout.trim(), "STEP6_OK");
    assert.equal(ctx.stored(), other);
  } finally {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test("맥 설치기: auth_rejected 면 --reset-token 으로 다시 실행하라고 안내한다", () => {
  const block = section(/\nif \[\[ "\$AUTH" != "ok" \]\]; then[\s\S]*?\nfi\n/, "auth 실패 구간");
  assert.match(block, /"\$AUTH" == "rejected"/);
  assert.match(block, /info "[^"\n]*--reset-token[^"\n]*"/);
  assert.match(block, /fail "auth_\$\{AUTH:-error\}"/);
});

// 설치기가 실제로 낼 수 있는 code= 값(맥·윈도우).
function printableCodes() {
  const authLabels = new Set([
    helloAuthLabel(null),
    helloAuthLabel({ status: 200, body: { ok: true } }),
    helloAuthLabel({ status: 401, body: {} }),
    helloAuthLabel({ status: 426, body: {} }),
    helloAuthLabel({ status: 503, body: { code: "COUPANG_SETUP_REQUIRED" } }),
    helloAuthLabel({ status: 404, body: null, routeMissing: true }),
    helloAuthLabel({ status: 0, body: null }),
    helloAuthLabel({ status: 500, body: {} }),
    ...[...WORKER.matchAll(/outcome\.auth = "([a-z_]+)"/g)].map((match) => match[1]),
  ]);
  authLabels.delete("ok");
  const mac = new Set([...INSTALLER.matchAll(/\bfail ([a-z0-9_]+)/g)].map((match) => match[1]));
  for (const match of INSTALLER.matchAll(/stop\("([a-z_]+)"\)/g)) mac.add(match[1]);
  const windows = new Set([...WINDOWS_INSTALLER.matchAll(/Stop-Install '([a-z0-9_]+)'/g)].map((match) => match[1]));
  windows.add("unexpected_error");
  assert.ok(INSTALLER.includes('fail "auth_${AUTH:-error}"'));
  assert.ok(WINDOWS_INSTALLER.includes('Stop-Install "auth_$auth"'));
  for (const label of authLabels) {
    mac.add(`auth_${label}`);
    windows.add(`auth_${label}`);
  }
  return { mac, windows, authLabels };
}

test("설치 문서 실패 표: 적힌 code= 는 모두 설치기가 실제로 내는 값이고, 출력에 없는 auth= 모양은 쓰지 않는다", () => {
  const { mac, windows, authLabels } = printableCodes();
  assert.deepEqual([...authLabels].sort(), ["config_invalid", "error", "locked", "node_version_unsupported", "rejected", "route_missing", "setup_required", "token_missing", "unreachable", "update_required"]);
  const [windowsPart, macPart] = SETUP_DOC.split("## 부록 — 맥");
  assert.ok(macPart, "맥 부록");
  const codesIn = (text) => [...text.matchAll(/`code=([a-z0-9_]+)`/g)].map((match) => match[1]);
  for (const code of codesIn(windowsPart)) assert.ok(windows.has(code), `윈도우 표: code=${code} 는 윈도우 설치기가 내지 않음`);
  for (const code of codesIn(macPart)) assert.ok(mac.has(code), `맥 부록: code=${code} 는 맥 설치기가 내지 않음`);
  // 설치 화면에는 auth=… 가 나오지 않는다(성공 줄의 auth=ok 만).
  for (const match of SETUP_DOC.matchAll(/auth=([a-z_]+)/g)) assert.equal(match[1], "ok", `문서의 auth=${match[1]}`);
  // 대표가 화면에서 볼 수 있는 인증 실패는 두 표 모두에 행이 있다.
  for (const code of ["connection_code_invalid", "auth_rejected", "auth_update_required", "auth_setup_required", "auth_route_missing", "auth_unreachable", "auth_error"]) {
    assert.ok(codesIn(windowsPart).includes(code), `윈도우 표에 code=${code} 없음`);
    assert.ok(codesIn(macPart).includes(code), `맥 부록에 code=${code} 없음`);
  }
  // 맥 회복 옵션은 --reset-token(윈도우는 -ResetToken).
  const macRejected = macPart.split("\n").find((line) => line.includes("`code=auth_rejected`"));
  assert.match(macRejected, / --reset-token/);
  const windowsRejected = windowsPart.split("\n").find((line) => line.includes("`code=auth_rejected`"));
  assert.match(windowsRejected, / -ResetToken/);
});
