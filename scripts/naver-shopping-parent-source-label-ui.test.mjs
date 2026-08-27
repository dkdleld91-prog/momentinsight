import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PAGE_PATHS = ["src/pages/admin.html", "src/pages/client.html"];

function extractNamedFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} must have a complete body`);
}

for (const pagePath of PAGE_PATHS) {
  test(`${pagePath} renders the trusted parent source beside current and history ranks`, () => {
    const source = fs.readFileSync(pagePath, "utf8");
    assert.match(source, /rankText\(tracker\.currentRank\) \+ \(currentSource \? " · " \+ currentSource : ""\)/u);
    const executable = [
      extractNamedFunction(source, "rankText"),
      extractNamedFunction(source, "rankSnapshotSourceLabel"),
      extractNamedFunction(source, "rankTrackerCurrentSourceLabel"),
      extractNamedFunction(source, "renderRankSlot"),
      `var tracker = {
          currentRank: 9,
          currentRankSource: "related_catalog",
          currentRankSourceLabel: "관련 원부 기준",
          snapshots: [],
        };
        var currentSource = rankTrackerCurrentSourceLabel(tracker);
        result = {
        current: rankText(tracker.currentRank) + (currentSource ? " · " + currentSource : ""),
        history: renderRankSlot({
          rank: 9,
          item: { trackingRankSource: "related_catalog" },
        }),
      };`,
    ].join("\n");
    const context = {
      result: null,
      escapeHtml(value) { return String(value); },
    };
    vm.runInNewContext(executable, context, { filename: pagePath });
    assert.equal(context.result.current, "9위 · 원부");
    assert.match(context.result.history, /<small>원부<\/small><b>9위<\/b>/u);
  });
}
