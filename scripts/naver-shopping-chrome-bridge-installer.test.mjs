import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeChromeProfileDecision,
  installChromeBridge,
  parseInstallerCliOptions,
  readChromeSchedulerProfileDirectory,
  resolveChromeProfileDirectory,
  resolveChromeSchedulerProfileSelection,
  runInstallerCli,
} from "./install-naver-shopping-chrome-bridge.mjs";

const repositoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerPath = path.join(repositoryPath, "scripts", "install-naver-shopping-chrome-bridge.mjs");

function schedulerConfigPath(homeDirectory) {
  return path.join(homeDirectory, "Library", "Application Support", "MomentInsight", "naver-shopping-chrome-scheduler.conf");
}

async function makeHome(context, { conf, localState } = {}) {
  // 실제 ~/Library 는 절대 건드리지 않는다. 임시 HOME 을 만들고 끝나면 지운다.
  const homeDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mi-bridge-installer-home-"));
  context.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const chromeApplicationPath = path.join(homeDirectory, "Desktop", "Google Chrome.app");
  const chromeExecutable = path.join(chromeApplicationPath, "Contents", "MacOS", "Google Chrome");
  fs.mkdirSync(path.dirname(chromeExecutable), { recursive: true });
  fs.writeFileSync(chromeExecutable, "#!/bin/sh\n", { mode: 0o700 });
  if (conf !== undefined) {
    const configPath = schedulerConfigPath(homeDirectory);
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, conf, { mode: 0o600 });
  }
  if (localState !== undefined) {
    const localStatePath = path.join(homeDirectory, "Library", "Application Support", "Google", "Chrome", "Local State");
    fs.mkdirSync(path.dirname(localStatePath), { recursive: true });
    fs.writeFileSync(localStatePath, JSON.stringify(localState));
  }
  return { homeDirectory, chromeApplicationPath };
}

function install(homeDirectory, chromeApplicationPath, extra = {}) {
  return installChromeBridge({
    repositoryPath,
    homeDirectory,
    chromeApplicationPath,
    keychainReady: () => true,
    disableOldAutomaticWorker: false,
    activateChromeScheduler: false,
    ...extra,
  });
}

test("G: 기존 conf 2행의 프로필 디렉터리를 읽고, 없거나 잘못되면 null", async (context) => {
  const withConf = await makeHome(context, { conf: "/Applications/Google Chrome.app\nProfile 5\n" });
  assert.equal(readChromeSchedulerProfileDirectory(withConf.homeDirectory), "Profile 5");
  const withoutConf = await makeHome(context);
  assert.equal(readChromeSchedulerProfileDirectory(withoutConf.homeDirectory), null);
  const invalidConf = await makeHome(context, { conf: "/Applications/Google Chrome.app\n../evil\n" });
  assert.equal(readChromeSchedulerProfileDirectory(invalidConf.homeDirectory), null);
  const oneLine = await makeHome(context, { conf: "/Applications/Google Chrome.app\n" });
  assert.equal(readChromeSchedulerProfileDirectory(oneLine.homeDirectory), null);
});

test("G: 명시 옵션이 없으면 기존 conf 의 프로필을 보존한다(기본 탐지 Default 보다 우선)", async (context) => {
  const { homeDirectory } = await makeHome(context, {
    conf: "/Applications/Google Chrome.app\nProfile 5\n",
    localState: { profile: { info_cache: { Default: { name: "동빈" } } } },
  });
  // 기존 탐지 함수는 그대로 Default 를 돌려준다(공개 시그니처·동작 불변).
  assert.equal(resolveChromeProfileDirectory(homeDirectory), "Default");
  const selection = resolveChromeSchedulerProfileSelection(homeDirectory, {});
  assert.deepEqual(selection, {
    profileDirectory: "Profile 5",
    profileSource: "preserved",
    previousProfileDirectory: "Profile 5",
    profileChanged: false,
  });
});

test("G: 명시 옵션은 기존 conf 보다 우선하고 변경 사실을 기록한다", async (context) => {
  const { homeDirectory } = await makeHome(context, { conf: "/Applications/Google Chrome.app\nProfile 5\n" });
  const changed = resolveChromeSchedulerProfileSelection(homeDirectory, { profileDirectory: "Profile 3" });
  assert.deepEqual(changed, {
    profileDirectory: "Profile 3",
    profileSource: "option",
    previousProfileDirectory: "Profile 5",
    profileChanged: true,
  });
  const same = resolveChromeSchedulerProfileSelection(homeDirectory, {
    profileDirectory: "Profile 5",
    profileDirectorySource: "cli",
  });
  assert.deepEqual(same, {
    profileDirectory: "Profile 5",
    profileSource: "cli",
    previousProfileDirectory: "Profile 5",
    profileChanged: false,
  });
  assert.throws(
    () => resolveChromeSchedulerProfileSelection(homeDirectory, { profileDirectory: "Profile 0" }),
    /chrome_profile_directory_invalid/u,
  );
});

test("G: conf 가 없으면 예전처럼 Local State 탐지로 떨어진다(source=detected)", async (context) => {
  const { homeDirectory } = await makeHome(context, {
    localState: { profile: { info_cache: { "Profile 2": { name: "동빈" }, Default: { name: "다른" } } } },
  });
  assert.deepEqual(resolveChromeSchedulerProfileSelection(homeDirectory, {}), {
    profileDirectory: "Profile 2",
    profileSource: "detected",
    previousProfileDirectory: null,
    profileChanged: false,
  });
});

test("G: CLI 인자 --profile-directory= 와 env MI_CHROME_PROFILE_DIRECTORY 를 해석한다", () => {
  assert.deepEqual(parseInstallerCliOptions(["node", "installer.mjs"], {}), {});
  assert.deepEqual(
    parseInstallerCliOptions(["node", "installer.mjs", "--profile-directory=Profile 5"], {}),
    { profileDirectory: "Profile 5", profileDirectorySource: "cli" },
  );
  assert.deepEqual(
    parseInstallerCliOptions(["node", "installer.mjs"], { MI_CHROME_PROFILE_DIRECTORY: "Profile 7" }),
    { profileDirectory: "Profile 7", profileDirectorySource: "env" },
  );
  // CLI 인자가 env 보다 우선한다.
  assert.deepEqual(
    parseInstallerCliOptions(
      ["node", "installer.mjs", "--profile-directory=Default"],
      { MI_CHROME_PROFILE_DIRECTORY: "Profile 7" },
    ),
    { profileDirectory: "Default", profileDirectorySource: "cli" },
  );
  // 빈 env 는 무시된다.
  assert.deepEqual(parseInstallerCliOptions(["node", "installer.mjs"], { MI_CHROME_PROFILE_DIRECTORY: "  " }), {});
  assert.throws(
    () => parseInstallerCliOptions(["node", "installer.mjs", "--profile-directory=../x"], {}),
    /chrome_profile_directory_invalid/u,
  );
  assert.throws(
    () => parseInstallerCliOptions(["node", "installer.mjs"], { MI_CHROME_PROFILE_DIRECTORY: "Profile" }),
    /chrome_profile_directory_invalid/u,
  );
  assert.throws(
    () => parseInstallerCliOptions(["node", "installer.mjs", "--profile-dir=Default"], {}),
    /chrome_bridge_install_argument_unknown/u,
  );
});

test("G: 설치기 재실행이 기존 conf 의 Profile 5 를 Default 로 되돌리지 않는다", async (context) => {
  const { homeDirectory, chromeApplicationPath } = await makeHome(context, {
    conf: "/Applications/Google Chrome.app\nProfile 5\n",
    localState: { profile: { info_cache: { Default: { name: "동빈" } } } },
  });
  const result = install(homeDirectory, chromeApplicationPath);
  const lines = fs.readFileSync(schedulerConfigPath(homeDirectory), "utf8").split("\n");
  assert.equal(lines[0], chromeApplicationPath);
  assert.equal(lines[1], "Profile 5");
  assert.equal(result.scheduler.profileDirectory, "Profile 5");
  assert.equal(result.scheduler.profileSource, "preserved");
  assert.equal(result.scheduler.previousProfileDirectory, "Profile 5");
  assert.equal(result.scheduler.profileChanged, false);
  assert.equal(result.scheduler.configPath, schedulerConfigPath(homeDirectory));
});

test("G: 명시 프로필 옵션은 conf 를 바꾸고 변경 사실을 결과에 남긴다", async (context) => {
  const { homeDirectory, chromeApplicationPath } = await makeHome(context, {
    conf: "/Applications/Google Chrome.app\nProfile 5\n",
  });
  const result = install(homeDirectory, chromeApplicationPath, { profileDirectory: "Profile 3" });
  assert.equal(fs.readFileSync(schedulerConfigPath(homeDirectory), "utf8").split("\n")[1], "Profile 3");
  assert.equal(result.scheduler.profileSource, "option");
  assert.equal(result.scheduler.previousProfileDirectory, "Profile 5");
  assert.equal(result.scheduler.profileChanged, true);
});

test("G: 워치독 모듈 경로(installChromeScheduler:false)는 conf 를 읽지도 쓰지도 않고 stdout 도 비어 있다", async (context) => {
  const original = "/Applications/Google Chrome.app\nProfile 5\n";
  const { homeDirectory } = await makeHome(context, { conf: original });
  const before = fs.statSync(schedulerConfigPath(homeDirectory));
  // 워치독과 같은 방식: 위치 인자 없이 --input-type=module -e 로 import 해 함수만 부른다.
  const stdout = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const { pathToFileURL } = await import('node:url');"
    + " const m = await import(pathToFileURL(process.env.MI_BRIDGE_INSTALLER).href);"
    + " const r = m.installChromeBridge({ installChromeScheduler: false, disableOldAutomaticWorker: false,"
    + " homeDirectory: process.env.MI_TEST_HOME, keychainReady: () => true });"
    + " if (r.scheduler !== null) throw new Error('scheduler_must_be_null');",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDirectory,
      MI_BRIDGE_INSTALLER: installerPath,
      MI_TEST_HOME: homeDirectory,
      MI_CHROME_PROFILE_DIRECTORY: "Profile 9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(stdout, "");
  assert.equal(fs.readFileSync(schedulerConfigPath(homeDirectory), "utf8"), original);
  const after = fs.statSync(schedulerConfigPath(homeDirectory));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.ok(!fs.existsSync(path.join(homeDirectory, "Library", "LaunchAgents")));
});

test("G: 보존/변경 사실을 stdout 한 줄로 만든다", () => {
  assert.equal(
    describeChromeProfileDecision({
      profileDirectory: "Profile 5", profileSource: "preserved", previousProfileDirectory: "Profile 5", profileChanged: false,
    }),
    "chrome_profile_directory preserved: Profile 5 (source=preserved, previous=Profile 5)",
  );
  assert.equal(
    describeChromeProfileDecision({
      profileDirectory: "Profile 3", profileSource: "cli", previousProfileDirectory: "Profile 5", profileChanged: true,
    }),
    "chrome_profile_directory changed: Profile 3 (source=cli, previous=Profile 5)",
  );
  assert.equal(
    describeChromeProfileDecision({
      profileDirectory: "Profile 5", profileSource: "env", previousProfileDirectory: "Profile 5", profileChanged: false,
    }),
    "chrome_profile_directory kept: Profile 5 (source=env, previous=Profile 5)",
  );
  assert.equal(
    describeChromeProfileDecision({
      profileDirectory: "Default", profileSource: "detected", previousProfileDirectory: null, profileChanged: false,
    }),
    "chrome_profile_directory set: Default (source=detected, previous=none)",
  );
  assert.equal(describeChromeProfileDecision(null), null);
  assert.equal(describeChromeProfileDecision({ configPath: "/x" }), null);
  assert.doesNotMatch(describeChromeProfileDecision({
    profileDirectory: "Profile 5", profileSource: "preserved", previousProfileDirectory: "Profile 5", profileChanged: false,
  }), /\n/u);
});

test("G: CLI 진입은 인자·env 를 해석해 설치 함수에 넘기고 결정 한 줄 + JSON 을 출력한다", () => {
  const calls = [];
  const out = [];
  const err = [];
  const fakeResult = {
    extensionId: "x",
    scheduler: {
      configPath: "/tmp/conf",
      profileDirectory: "Profile 5",
      profileSource: "preserved",
      previousProfileDirectory: "Profile 5",
      profileChanged: false,
    },
  };
  const code = runInstallerCli({
    argv: ["node", "installer.mjs"],
    env: {},
    install: (options) => { calls.push(options); return fakeResult; },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{}]);
  assert.equal(out.length, 2);
  assert.equal(out[0], "chrome_profile_directory preserved: Profile 5 (source=preserved, previous=Profile 5)");
  assert.deepEqual(JSON.parse(out[1]), fakeResult);
  assert.deepEqual(err, []);

  const cliCalls = [];
  const cliOut = [];
  const cliCode = runInstallerCli({
    argv: ["node", "installer.mjs", "--profile-directory=Profile 3"],
    env: { MI_CHROME_PROFILE_DIRECTORY: "Profile 8" },
    install: (options) => {
      cliCalls.push(options);
      return { scheduler: { profileDirectory: "Profile 3", profileSource: "cli", previousProfileDirectory: "Profile 5", profileChanged: true } };
    },
    stdout: (line) => cliOut.push(line),
    stderr: () => {},
  });
  assert.equal(cliCode, 0);
  assert.deepEqual(cliCalls, [{ profileDirectory: "Profile 3", profileDirectorySource: "cli" }]);
  assert.equal(cliOut[0], "chrome_profile_directory changed: Profile 3 (source=cli, previous=Profile 5)");

  const envCalls = [];
  runInstallerCli({
    argv: ["node", "installer.mjs"],
    env: { MI_CHROME_PROFILE_DIRECTORY: "Profile 8" },
    install: (options) => { envCalls.push(options); return { scheduler: null }; },
    stdout: () => {},
    stderr: () => {},
  });
  assert.deepEqual(envCalls, [{ profileDirectory: "Profile 8", profileDirectorySource: "env" }]);

  // 잘못된 인자는 설치 함수를 부르지 않고 exit 1 로 끝난다.
  const badCalls = [];
  const badErr = [];
  const badCode = runInstallerCli({
    argv: ["node", "installer.mjs", "--profile-directory=nope"],
    env: {},
    install: (options) => { badCalls.push(options); return {}; },
    stdout: () => {},
    stderr: (line) => badErr.push(line),
  });
  assert.equal(badCode, 1);
  assert.deepEqual(badCalls, []);
  assert.deepEqual(badErr, ["chrome_profile_directory_invalid"]);

  // 설치 함수의 예외도 예전처럼 메시지 한 줄 + exit 1 이다.
  const failErr = [];
  const failCode = runInstallerCli({
    argv: ["node", "installer.mjs"],
    env: {},
    install: () => { throw new Error("native_host_keychain_secret_missing_or_weak"); },
    stdout: () => {},
    stderr: (line) => failErr.push(line),
  });
  assert.equal(failCode, 1);
  assert.deepEqual(failErr, ["native_host_keychain_secret_missing_or_weak"]);
});

test("G: 직접 실행 블록은 runInstallerCli 를 거치고 process.argv·process.env 를 그대로 쓴다", () => {
  const source = fs.readFileSync(installerPath, "utf8");
  assert.match(source, /if \(directlyExecuted\) \{\s*process\.exitCode = runInstallerCli\(\);/u);
  assert.match(source, /MI_CHROME_PROFILE_DIRECTORY/u);
  assert.match(source, /--profile-directory/u);
  // 워치독 문서·테스트가 의존하는 자동 실행 판정은 그대로 둔다.
  assert.match(source, /const directlyExecuted = process\.argv\[1\]\s*&& path\.resolve\(process\.argv\[1\]\) === path\.resolve\(fileURLToPath\(import\.meta\.url\)\);/u);
});
