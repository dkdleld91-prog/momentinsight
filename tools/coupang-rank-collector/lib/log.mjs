// 한 줄 기록(명세 §9.2 lib/log.mjs). <root>/logs/worker.log 에 "ISO시각 이벤트 키=값 …" 으로 쓴다.
// 1MB 를 넘으면 worker.log.1 로 바꾼다. 키워드·토큰·제목은 남기지 않는다(키 이름으로 막고, 값의 연결 코드 모양도 지운다).
import fs from "node:fs";
import path from "node:path";
import { LOG_MAX_BYTES } from "./contract.mjs";

const BLOCKED_KEY = /keyword|token|title|authorization|secret|^t$|^q$/i;
const TOKEN_LIKE = /mic1_[A-Za-z0-9_-]{8,}/g;
const EVENT_PATTERN = /^[a-z0-9_]{1,60}$/;

export function formatValue(value) {
  if (value === null || value === undefined) return "-";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  text = text.replace(TOKEN_LIKE, "mic1_REDACTED").replace(/[\s=]+/g, "_");
  if (!text) return "-";
  return Array.from(text).slice(0, 120).join("");
}

export function formatLine(event, fields = {}, now = new Date()) {
  const name = EVENT_PATTERN.test(String(event)) ? String(event) : "log_event_invalid";
  const parts = [now.toISOString(), name];
  for (const [key, value] of Object.entries(fields || {})) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || BLOCKED_KEY.test(key)) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return `${parts.join(" ")}\n`;
}

export function createLogger(root, { now = () => new Date(), maxBytes = LOG_MAX_BYTES, echo = null } = {}) {
  const dir = path.join(path.resolve(root), "logs");
  const file = path.join(dir, "worker.log");
  const lines = [];
  function event(name, fields = {}) {
    const line = formatLine(name, fields, now());
    lines.push(line);
    if (lines.length > 500) lines.shift();
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
      } catch {
        // 아직 파일이 없다.
      }
      fs.appendFileSync(file, line, "utf8");
    } catch {
      // 기록 실패가 수집을 멈추게 하지 않는다.
    }
    if (typeof echo === "function") {
      try { echo(line); } catch { /* 무시 */ }
    }
    return line;
  }
  return { event, file, lines };
}

// 테스트·내부용: 기록을 버리는 기록기.
export function nullLogger() {
  const lines = [];
  return { event: (name, fields) => { const line = formatLine(name, fields); lines.push(line); return line; }, file: null, lines };
}
