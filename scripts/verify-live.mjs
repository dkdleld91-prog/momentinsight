// 배포 직후 프로덕션을 1회 검증한다. 지금까지 배포 후 자동 검증은 0건이었고,
// 릴리스 해시는 사람이 문서에 손으로 옮겨 적어 왔다.
//   ① /health.release == git rev-parse --short=12 origin/main  (잘못된 브랜치·미배포 탐지)
//   ② /ready ok:true                                            (의존성 준비 상태)
//   ③ /admin·/client 200 · 비인증 /api/session 401              (화면 생존 + 인증 경계)
//   ④ /api/rank-collection-health 200 + 워치독 6키 계약           (워치독이 읽는 표면)
// 하나라도 실패하면 exit 1. 비교 기준은 MI_VERIFY_LIVE_RELEASE 로 덮어쓸 수 있다.
import { execFileSync } from "node:child_process";

const BASE = String(process.env.MI_VERIFY_LIVE_BASE_URL || "https://insight.momentlabs.co.kr").replace(/\/+$/, "");
// 정렬된 6키 계약. 앞의 4키는 워치독(mi-rank-watchdog.sh)이 grep 으로 직접 읽는 표면이라
// 이름·의미를 바꾸지 않는다. 뒤의 2키는 2026-09-01 버전 불일치 17시간 정지(서버 1.1.20 /
// 윈도우 워커 1.1.19)를 조기에 드러내려고 이번에 추가한 집계값이다 — workerOutdated 는
// 버전 문자열·기기명을 노출하지 않는 boolean 이고, heartbeatAgeMinutes 는 정수 분이다.
// 이 배열은 정렬 비교에 쓰이므로 사전순을 유지해야 한다.
const RANK_HEALTH_KEYS = [
  "heartbeatAgeMinutes",
  "lastSuccessAt",
  "ok",
  "queueStalled",
  "stalledMinutes",
  "workerOutdated",
];
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

// git rev-parse 는 원격에 접속하지 않고 로컬 remote-tracking ref 만 읽는다. 마지막
// fetch 이후 origin/main 이 움직였으면 기준이 낡아, GitHub 에서 병합된 정상 배포를
// "잘못된 브랜치"로 오진하거나 반대로 뒤처진 프로덕션을 PASS 로 놓친다. 그래서 비교
// 전에 항상 origin/main 을 먼저 당기고, fetch 가 실패하면 그 사실을 출력에 드러낸다.
function expectedRelease() {
  const override = String(process.env.MI_VERIFY_LIVE_RELEASE || "").trim();
  if (override) return { release: override, source: "override" };
  let source = "fetched";
  try {
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "ignore", timeout: 30_000 });
  } catch {
    source = "fetch_failed";
  }
  const release = execFileSync("git", ["rev-parse", "--short=12", "origin/main"], { encoding: "utf8" }).trim();
  return { release, source };
}

async function probe(path) {
  try {
    const response = await fetch(`${BASE}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body };
  } catch (error) {
    return { status: 0, body: null, error: String(error?.message || "request_failed") };
  }
}

const { release: expected, source: expectedSource } = expectedRelease();
const health = await probe("/health");
record(
  `1) /health.release == origin/main(${expected})`,
  health.status === 200 && String(health.body?.release || "") === expected && expectedSource !== "fetch_failed",
  `http=${health.status} release=${String(health.body?.release || health.error || "none")} base=${expectedSource}`,
);

const ready = await probe("/ready");
record("2) /ready ok:true", ready.status === 200 && ready.body?.ok === true, `http=${ready.status} ok=${String(ready.body?.ok)}`);

const admin = await probe("/admin");
const client = await probe("/client");
const session = await probe("/api/session");
record("3) /admin 200", admin.status === 200, `http=${admin.status}`);
record("3) /client 200", client.status === 200, `http=${client.status}`);
record("3) 비인증 GET /api/session 401", session.status === 401, `http=${session.status}`);

const rankHealth = await probe("/api/rank-collection-health");
const rankKeys = rankHealth.body && typeof rankHealth.body === "object" ? Object.keys(rankHealth.body).sort() : [];
record(
  `4) /api/rank-collection-health 200 + 키 [${RANK_HEALTH_KEYS.join(",")}]`,
  rankHealth.status === 200 && rankKeys.length === RANK_HEALTH_KEYS.length && rankKeys.every((key, index) => key === RANK_HEALTH_KEYS[index]),
  `http=${rankHealth.status} keys=[${rankKeys.join(",")}]`,
);

console.log(`verify:live target=${BASE}`);
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} — ${result.detail}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`verify:live ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
