// state/worker.lock 디렉터리 잠금(명세 §9.2). 이미 있으면 안의 pid 파일 시각이 20분 지났을 때만 지우고 다시 만든다.
// 설치기는 이 디렉터리가 없어질 때까지 기다린 뒤 app 을 바꾼다.
import fs from "node:fs";
import path from "node:path";
import { LOCK_STALE_MS } from "./contract.mjs";

export function acquireLock(root, { now = () => Date.now(), staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  const stateDir = path.join(path.resolve(root), "state");
  const lockDir = path.join(stateDir, "worker.lock");
  const pidFile = path.join(lockDir, "pid");
  fs.mkdirSync(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, `${pid}\n`, "utf8");
      let released = false;
      return {
        ok: true,
        dir: lockDir,
        refresh() {
          if (released) return;
          try {
            const at = new Date(now());
            fs.utimesSync(pidFile, at, at);
          } catch { /* 무시 */ }
        },
        release() {
          if (released) return;
          released = true;
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* 무시 */ }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") return { ok: false, reason: "lock_error" };
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(pidFile).mtimeMs;
      } catch {
        try { mtimeMs = fs.statSync(lockDir).mtimeMs; } catch { mtimeMs = now(); }
      }
      if (now() - mtimeMs <= staleMs) return { ok: false, reason: "locked" };
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { return { ok: false, reason: "lock_error" }; }
    }
  }
  return { ok: false, reason: "locked" };
}
