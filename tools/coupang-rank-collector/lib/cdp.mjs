// 의존성 없는 CDP 연결(명세 §9.2 lib/cdp.mjs). 브라우저 소켓 하나에 flatten 세션(sessionId)으로 탭을 다룬다.
// Node 22 이상의 전역 WebSocket 만 쓴다. 명령마다 30초 제한.
export const CDP_COMMAND_TIMEOUT_MS = 30000;

export class CdpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export class CdpConnection {
  constructor(socket, { commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.closed = false;
    socket.addEventListener("message", (event) => this.#onMessage(event));
    socket.addEventListener("close", () => this.#onClose());
    socket.addEventListener("error", () => this.#onClose());
  }

  static async connect(wsUrl, { WebSocketImpl = globalThis.WebSocket, openTimeoutMs = 10000, commandTimeoutMs } = {}) {
    if (typeof WebSocketImpl !== "function") throw new CdpError("cdp_unreachable", "websocket_unavailable");
    let socket;
    try {
      socket = new WebSocketImpl(wsUrl);
    } catch {
      throw new CdpError("cdp_unreachable", "websocket_construct_failed");
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* 무시 */ }
        reject(new CdpError("cdp_unreachable", "websocket_open_timeout"));
      }, openTimeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new CdpError("cdp_unreachable", "websocket_error")); }, { once: true });
    });
    return new CdpConnection(socket, { commandTimeoutMs });
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message && message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError("cdp_error", `${entry.method}: ${message.error.message || "error"}`));
      else entry.resolve(message.result || {});
      return;
    }
    if (!message || typeof message.method !== "string") return;
    for (const handler of [...this.handlers]) {
      if (handler.method !== message.method) continue;
      if (handler.sessionId !== undefined && handler.sessionId !== (message.sessionId || null)) continue;
      try { handler.fn(message.params || {}, message); } catch { /* 처리기 오류는 연결을 깨지 않는다 */ }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CdpError("cdp_error", `${entry.method}: socket_closed`));
      this.pending.delete(id);
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new CdpError("cdp_error", `${method}: socket_closed`));
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new CdpError("cdp_error", `${method}: timeout`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.socket.send(JSON.stringify(payload));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError("cdp_error", `${method}: send_failed`));
      }
    });
  }

  // sessionId 를 주면 그 세션 사건만, null 이면 브라우저 사건만, 생략하면 모두 받는다.
  on(method, fn, sessionId) {
    const handler = { method, fn, sessionId: sessionId === undefined ? undefined : (sessionId || null) };
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // 사건이 오면 params, 제한 시간 안에 없으면 null.
  waitFor(method, timeoutMs, sessionId) {
    return new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      off = this.on(method, (params) => { clearTimeout(timer); off(); resolve(params); }, sessionId);
    });
  }

  close() {
    try { this.socket.close(); } catch { /* 무시 */ }
    this.#onClose();
  }
}
