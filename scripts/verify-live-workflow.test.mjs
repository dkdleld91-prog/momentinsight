// 배포 후 라이브 검증을 CI 가 대신 돌린다. 지금까지 `npm run verify:live` 는 사람이
// 로컬에서 기억날 때만 쳤고, 실행 기록도 남지 않았다. 이 테스트는 그 자동화를 이루는
// 세 조각을 고정한다.
//   ① /health 가 어느 브랜치의 배포인지 스스로 밝힌다(branch 키).
//   ② verify-live.mjs 가 "체크아웃이 신선하다"는 호출자 보증을 받아들인다(skip-fetch).
//   ③ .github/workflows/verify-live.yml 이 성공한 production 배포에만 반응하고,
//      실패하면 알림 채널로 새어 나간다.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import healthHandler from "../src/server/handlers/health.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative) => fs.readFileSync(path.join(repositoryRoot, relative), "utf8");

const HEALTH_KEYS_IN_ORDER = ["ok", "status", "service", "region", "release", "branch", "time"];
const RANK_HEALTH_KEYS_SORTED = [
  "heartbeatAgeMinutes",
  "lanes",
  "lastSuccessAt",
  "ok",
  "queueStalled",
  "stalledMinutes",
  "trackers",
  "workerOutdated",
];
// verify-live.mjs 가 대조하는 8키를 응답 순서 그대로 담은 스텁 본문.
const RANK_HEALTH_STUB_BODY = {
  ok: true,
  lastSuccessAt: "2026-09-03T00:00:00.000Z",
  stalledMinutes: 0,
  queueStalled: false,
  workerOutdated: false,
  heartbeatAgeMinutes: 0,
  lanes: {},
  trackers: { neverFound: 0, stuck: 0 },
};

const HEALTH_ENV_KEYS = ["VERCEL_GIT_COMMIT_REF", "VERCEL_GIT_COMMIT_SHA", "GIT_COMMIT_SHA", "VERCEL_REGION"];

function snapshotEnv(keys) {
  const saved = new Map();
  for (const key of keys) saved.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function healthBody() {
  const response = await healthHandler.fetch(new Request("https://insight.momentlabs.co.kr/health"));
  assert.equal(response.status, 200);
  return await response.json();
}

// 프로덕션 6항목을 그대로 흉내 내는 최소 스텁. 포트는 0 으로 받아 다른 세션과
// 충돌하지 않게 한다.
function startStubServer({ release }) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const sendJson = (status, body) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    const sendHtml = (status, body) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    };
    switch (pathname) {
      case "/health":
        return sendJson(200, {
          ok: true,
          status: "live",
          service: "moment-insight-api",
          region: "stub",
          release,
          branch: "main",
          time: new Date().toISOString(),
        });
      case "/ready":
        return sendJson(200, { ok: true });
      case "/admin":
        return sendHtml(200, "<!doctype html><title>admin</title>");
      case "/client":
        return sendHtml(200, "<!doctype html><title>client</title>");
      case "/api/session":
        return sendJson(401, { ok: false, error: "unauthorized" });
      case "/api/rank-collection-health":
        return sendJson(200, RANK_HEALTH_STUB_BODY);
      default:
        return sendJson(404, { ok: false, error: "not_found" });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function verifyLiveEnv(overrides) {
  const env = { ...process.env };
  delete env.MI_VERIFY_LIVE_BASE_URL;
  delete env.MI_VERIFY_LIVE_RELEASE;
  delete env.MI_VERIFY_LIVE_SKIP_FETCH;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

async function runVerifyLive(env) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/verify-live.mjs"], {
      cwd: repositoryRoot,
      env,
      timeout: 120_000,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    return {
      code: typeof error?.code === "number" ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || ""),
    };
  }
}

function localOriginMainRelease() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    return "";
  }
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "origin/main"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

test("A1: /health 는 배포된 브랜치를 branch 키로 밝힌다", async () => {
  const saved = snapshotEnv(HEALTH_ENV_KEYS);
  try {
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    const body = await healthBody();
    assert.equal(body.branch, "main");
  } finally {
    restoreEnv(saved);
  }
});

test("A1: VERCEL_GIT_COMMIT_REF 가 없으면 branch 는 단정하지 않고 빈 문자열이다", async () => {
  const saved = snapshotEnv(HEALTH_ENV_KEYS);
  try {
    delete process.env.VERCEL_GIT_COMMIT_REF;
    const body = await healthBody();
    assert.equal(body.branch, "");
  } finally {
    restoreEnv(saved);
  }
});

test("A1: /health 응답 키는 순서까지 고정이고 release 는 12자 절단이다", async () => {
  const saved = snapshotEnv(HEALTH_ENV_KEYS);
  try {
    process.env.VERCEL_GIT_COMMIT_REF = "main";
    process.env.VERCEL_GIT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
    const body = await healthBody();
    // branch 는 release 바로 뒤다. 워치독·문서가 읽는 앞 5키의 자리는 그대로 둔다.
    assert.deepEqual(Object.keys(body), HEALTH_KEYS_IN_ORDER);
    assert.equal(body.release, "0123456789ab");
    assert.equal(body.release.length, 12);
    assert.equal(body.ok, true);
    assert.equal(body.status, "live");
    assert.equal(body.service, "moment-insight-api");
  } finally {
    restoreEnv(saved);
  }
});

test("A2: 스텁 프로덕션 6항목을 모두 통과하면 exit 0 · base=override", async () => {
  const release = "abc123def456";
  const { server, url } = await startStubServer({ release });
  try {
    const result = await runVerifyLive(
      verifyLiveEnv({ MI_VERIFY_LIVE_BASE_URL: url, MI_VERIFY_LIVE_RELEASE: release }),
    );
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /6\/6 passed/u);
    assert.match(result.stdout, /base=override/u);
  } finally {
    await closeServer(server);
  }
});

test("A2: release 가 어긋나면 1번 항목이 FAIL 이고 exit 1 이다", async () => {
  const { server, url } = await startStubServer({ release: "0000deadbeef" });
  try {
    const result = await runVerifyLive(
      verifyLiveEnv({ MI_VERIFY_LIVE_BASE_URL: url, MI_VERIFY_LIVE_RELEASE: "abc123def456" }),
    );
    assert.equal(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /FAIL 1\)/u);
  } finally {
    await closeServer(server);
  }
});

test("A2: MI_VERIFY_LIVE_SKIP_FETCH 는 fetch 없이 origin/main 만 읽는다(base=checkout)", async (t) => {
  const release = localOriginMainRelease();
  if (!release) {
    t.skip("로컬에 origin/main remote-tracking ref 가 없어 skip-fetch 경로를 실행할 수 없다");
    return;
  }
  const { server, url } = await startStubServer({ release });
  try {
    const result = await runVerifyLive(
      verifyLiveEnv({ MI_VERIFY_LIVE_BASE_URL: url, MI_VERIFY_LIVE_SKIP_FETCH: "1" }),
    );
    assert.equal(result.code, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /base=checkout/u);
    assert.match(result.stdout, /6\/6 passed/u);
  } finally {
    await closeServer(server);
  }
});

test("A2: skip-fetch 분기는 소스에 남아 있고 8키 계약은 그대로다", () => {
  const verifyLive = readRepoFile("scripts/verify-live.mjs");
  assert.match(verifyLive, /MI_VERIFY_LIVE_SKIP_FETCH/u);
  assert.match(verifyLive, /"checkout"/u);
  // 기존 fetch 경로·override 경로는 사라지지 않는다.
  assert.match(verifyLive, /"override"/u);
  assert.match(verifyLive, /"fetch_failed"/u);
  assert.ok(verifyLive.includes("rankKeys.length === RANK_HEALTH_KEYS.length"));
  const arrayStart = verifyLive.indexOf("const RANK_HEALTH_KEYS = [");
  const arrayEnd = verifyLive.indexOf("];", arrayStart);
  const declared = [...verifyLive.slice(arrayStart, arrayEnd).matchAll(/"([A-Za-z]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(declared, RANK_HEALTH_KEYS_SORTED, "verify-live 8키 계약 배열은 그대로여야 한다");
});

test("A3: verify-live 워크플로는 성공한 production 배포와 하루 2회 스케줄에만 돈다", () => {
  const workflow = readRepoFile(".github/workflows/verify-live.yml");
  assert.match(workflow, /name: Verify Live/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /cron: "23 1,13 \* \* \*"/u);
  assert.match(workflow, /deployment_status:/u);
  // Preview·pending 배포에는 반응하지 않는다.
  assert.match(workflow, /github\.event\.deployment_status\.state == 'success'/u);
  assert.match(workflow, /contains\(github\.event\.deployment\.environment, 'production'\)/u);
  assert.match(workflow, /group: verify-live/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /permissions:\n {2}contents: read/u);
});

test("A3: 체크아웃·Node 는 quality.yml 과 같은 커밋에 고정되고 자격증명을 남기지 않는다", () => {
  const workflow = readRepoFile(".github/workflows/verify-live.yml");
  const quality = readRepoFile(".github/workflows/quality.yml");
  const pin = (source, action) => {
    const match = source.match(new RegExp(`uses:\\s*actions/${action}@([0-9a-f]{40})`, "u"));
    assert.ok(match, `${action} 은 40자 커밋 SHA 로 고정돼야 한다`);
    return match[1];
  };
  assert.equal(pin(workflow, "checkout"), pin(quality, "checkout"), "checkout SHA 는 quality.yml 과 같아야 한다");
  assert.equal(pin(workflow, "setup-node"), pin(quality, "setup-node"), "setup-node SHA 는 quality.yml 과 같아야 한다");
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /node-version: 22/u);
  assert.match(workflow, /npm ci/u);
});

test("A3: 워크플로는 skip-fetch 로 verify:live 를 돌리고 기본 대상은 프로덕션이다", () => {
  const workflow = readRepoFile(".github/workflows/verify-live.yml");
  assert.match(workflow, /npm run verify:live/u);
  assert.match(workflow, /MI_VERIFY_LIVE_SKIP_FETCH: "1"/u);
  assert.match(workflow, /https:\/\/insight\.momentlabs\.co\.kr/u);
});

test("A3: 실패는 알림 채널로 새어 나가고, DB 자격증명은 올리지 않는다", () => {
  const workflow = readRepoFile(".github/workflows/verify-live.yml");
  assert.match(workflow, /name: Notify alert channel on failure/u);
  assert.match(workflow, /failure\(\)/u);
  assert.match(workflow, /DISCORD_WEBHOOK_URL != ''/u);
  assert.match(workflow, /TELEGRAM_BOT_TOKEN/u);
  // 웹훅 URL 이 로그에 새지 않도록 응답 본문은 버리고 상세 로그 옵션은 쓰지 않는다.
  assert.match(workflow, /--output \/dev\/null/u);
  assert.doesNotMatch(workflow, /curl -v/u);
  assert.doesNotMatch(workflow, / -v /u);
  // 알림 실패가 잡의 결론을 바꾸지 않는다.
  assert.match(workflow, /exit 0/u);
  // 라이브 검증은 공개 HTTP 표면만 읽는다. DB 자격증명은 이 워크플로에 존재할 이유가 없다.
  assert.doesNotMatch(workflow, /SUPABASE/u);
});

test("A4: 새 테스트는 npm test 목록에 등록돼 있다", () => {
  const manifest = JSON.parse(readRepoFile("package.json"));
  assert.match(manifest.scripts.test, /scripts\/verify-live-workflow\.test\.mjs/u);
});
