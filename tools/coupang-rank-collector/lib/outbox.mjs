// 보고 실패 보관·재전송(명세 §9.2 lib/outbox.mjs, M1). outbox/<runId>.json 에 record 본문을 둔다.
// 서버가 알려진 최종 코드(RECORD_FINAL_CODES)로 거절할 때만 버린다. 코드 없는 4xx(경로 덮임)는 남기고 실행을 끝낸다.
import fs from "node:fs";
import path from "node:path";
import { OUTBOX_MAX_AGE_MINUTES, OUTBOX_MAX_FILES, RECORD_FINAL_CODES } from "./contract.mjs";

export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function outboxDir(root) {
  return path.join(path.resolve(root), "outbox");
}

function shortRun(runId) {
  return String(runId || "").slice(0, 8);
}

export function listOutbox(root) {
  const dir = outboxDir(root);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const runId = name.slice(0, -5);
    const file = path.join(dir, name);
    if (!RUN_ID_PATTERN.test(runId)) {
      try { fs.rmSync(file, { force: true }); } catch { /* 무시 */ }
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const savedAt = Date.parse(data?.savedAt);
      if (!Number.isFinite(savedAt) || !data?.body || typeof data.body !== "object") throw new Error("outbox_invalid");
      entries.push({ runId, file, savedAt, body: data.body });
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* 무시 */ }
    }
  }
  entries.sort((a, b) => a.savedAt - b.savedAt || a.runId.localeCompare(b.runId));
  return entries;
}

export function saveOutbox(root, runId, body, { log, now = Date.now, maxFiles = OUTBOX_MAX_FILES } = {}) {
  if (!RUN_ID_PATTERN.test(String(runId || ""))) return false;
  const dir = outboxDir(root);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ savedAt: new Date(now()).toISOString(), body }), "utf8");
    fs.renameSync(temp, file);
  } catch {
    return false;
  }
  log?.event?.("outbox_saved", { run: shortRun(runId) });
  const entries = listOutbox(root);
  for (const entry of entries.slice(0, Math.max(0, entries.length - maxFiles))) {
    try { fs.rmSync(entry.file, { force: true }); } catch { /* 무시 */ }
    log?.event?.("outbox_dropped", { run: shortRun(entry.runId), reason: "count" });
  }
  return true;
}

// 실행을 시작할 때 부른다. stop:true 면 이번 실행을 끝낸다(401·426·routeMissing).
export async function flushOutbox({ root, api, log, now = Date.now, maxAgeMs = OUTBOX_MAX_AGE_MINUTES * 60000 }) {
  const result = { stop: false, reason: null, sent: 0, dropped: 0, kept: 0 };
  for (const entry of listOutbox(root)) {
    if (now() - entry.savedAt > maxAgeMs) {
      try { fs.rmSync(entry.file, { force: true }); } catch { /* 무시 */ }
      log?.event?.("outbox_dropped", { run: shortRun(entry.runId), reason: "age" });
      result.dropped += 1;
      continue;
    }
    const response = await api.record(entry.body);
    const status = response?.status || 0;
    const code = typeof response?.body?.code === "string" ? response.body.code : null;
    if (status >= 200 && status < 300) {
      try { fs.rmSync(entry.file, { force: true }); } catch { /* 무시 */ }
      log?.event?.("outbox_sent", { run: shortRun(entry.runId), duplicate: Boolean(response?.body?.duplicate) });
      result.sent += 1;
      continue;
    }
    if (status === 401 || status === 426) {
      result.kept += 1;
      result.stop = true;
      result.reason = status === 401 ? "auth_rejected" : "update_required";
      log?.event?.("record", { run: shortRun(entry.runId), http: status, code: code || "-", outbox: 1 });
      return result;
    }
    if (response?.routeMissing) {
      result.kept += 1;
      result.stop = true;
      result.reason = "route_missing";
      log?.event?.("api_route_missing", { http: status, stage: "outbox" });
      return result;
    }
    if (status >= 400 && status < 500 && code && RECORD_FINAL_CODES.includes(code)) {
      try { fs.rmSync(entry.file, { force: true }); } catch { /* 무시 */ }
      log?.event?.("record_dropped", { run: shortRun(entry.runId), code });
      result.dropped += 1;
      continue;
    }
    result.kept += 1;
    if (status === 0 || status >= 500) {
      // 서버에 닿지 않는다. 남은 파일은 다음 실행이 보낸다.
      log?.event?.("record", { run: shortRun(entry.runId), http: status, outbox: 1, kept: 1 });
      if (status === 0) log?.event?.("api_unreachable", { stage: "outbox" });
      break;
    }
    log?.event?.("record", { run: shortRun(entry.runId), http: status, code: code || "-", outbox: 1, kept: 1 });
  }
  return result;
}
