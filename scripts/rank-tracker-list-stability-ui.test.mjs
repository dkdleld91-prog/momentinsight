import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 2026-09-13 서버 안정화: 순위 목록 조회의 브라우저 측 보강이 client.html 에 그대로 있는지 고정한다.
const pages = ["src/pages/client.html", "src/pages/admin.html"]
  .map((relative) => fs.readFileSync(path.join(process.cwd(), relative), "utf8"));

test("rank tracker list GET waits 30 seconds and retries a failed connection once", () => {
  for (const clientSource of pages) {
  assert.ok(clientSource.includes('(method === "GET" ? 30000 : 20000)'));
  assert.ok(clientSource.includes("if (method !== \"GET\" || requestGeneration !== rankRequestGeneration || !sameRankTrackerScope(requestScope)) throw firstError;"));
  assert.ok(clientSource.includes("setTimeout(resolve, 1500)"));
  // 재시도는 한 번뿐이다: 두 번째 miFetch 는 try 밖에서 그대로 throw 한다.
  const catchIndex = clientSource.indexOf("catch (firstError)");
  const retryBlock = clientSource.slice(catchIndex, clientSource.indexOf("var payload = await response.json()", catchIndex));
  assert.equal((retryBlock.match(/await miFetch\(url, options\)/g) || []).length, 1);
  }
});

test("the connection-failure banner names the reason and promises the automatic reload", () => {
  for (const clientSource of pages) {
  assert.ok(clientSource.includes("function rankConnectionFailureReason(error)"));
  assert.ok(clientSource.includes('"순위 추적 서버 연결 실패(" + rankConnectionFailureReason(error) + ")로 마지막 정상 순위와 이력을 유지합니다. 잠시 후 자동으로 다시 불러옵니다."'));
  assert.ok(clientSource.includes('return "요청 시간 초과 30초·재시도 1회";'));
  assert.ok(clientSource.includes('return "네트워크 오류·재시도 1회";'));
  }
});
