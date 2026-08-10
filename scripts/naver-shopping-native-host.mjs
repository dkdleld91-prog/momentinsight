import crypto from "node:crypto";

import { runLocalShoppingWorker } from "./naver-shopping-local-worker.mjs";
import { createChromeNativeProvider } from "./naver-shopping-native-host-core.mjs";

const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
// One exact 300-rank collection can spend up to 45 seconds before page 1,
// then 45-75 seconds between each of the remaining seven pages. Keep the
// native exchange below the 35-minute server lease but above that bounded
// visible-browser schedule.
const RESPONSE_TIMEOUT_MS = 29 * 60_000;
// 09:00/15:00 are customer-facing expectation windows. The internal catch-up
// alarm is the continuous whole-site cycle: it idempotently makes every active
// tracker due, then the bounded worker claims only the oldest remaining job.
const WHOLE_SITE_QUEUE_TRIGGERS = new Set(["manual", "rank-catch-up"]);
let inputBuffer = Buffer.alloc(0);
const messageQueue = [];
const messageWaiters = [];
let inputFailure = null;

function safeCode(error) {
  const value = typeof error === "string" ? error : error?.code || error?.message;
  return String(value || "native_host_failed")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/gu, "_")
    .slice(0, 80) || "native_host_failed";
}

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > 1024 * 1024) throw new Error("native_host_output_too_large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function deliverMessage(message) {
  const waiter = messageWaiters.shift();
  if (waiter) waiter.resolve(message);
  else messageQueue.push(message);
}

function consumeInput() {
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (length < 2 || length > MAX_MESSAGE_BYTES) throw new Error("native_host_input_too_large");
    if (inputBuffer.length < length + 4) return;
    const body = inputBuffer.subarray(4, length + 4);
    inputBuffer = inputBuffer.subarray(length + 4);
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("native_host_input_invalid_json");
    }
    deliverMessage(message);
  }
}

process.stdin.on("data", (chunk) => {
  if (inputFailure) return;
  try {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    consumeInput();
  } catch (error) {
    inputFailure = error;
    while (messageWaiters.length) messageWaiters.shift().reject(error);
  }
});

function nextMessage(timeoutMs = RESPONSE_TIMEOUT_MS) {
  if (inputFailure) return Promise.reject(inputFailure);
  if (messageQueue.length) return Promise.resolve(messageQueue.shift());
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    const timeout = setTimeout(() => {
      const index = messageWaiters.indexOf(waiter);
      if (index >= 0) messageWaiters.splice(index, 1);
      reject(new Error("native_host_response_timeout"));
    }, timeoutMs);
    waiter.resolve = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
    messageWaiters.push(waiter);
  });
}

async function main() {
  const start = await nextMessage(60_000);
  if (start?.action !== "run") throw new Error("native_host_start_invalid");
  writeMessage({ type: "ready" });
  const readyAck = await nextMessage(30_000);
  if (readyAck?.action !== "ready_ack") throw new Error("native_host_ready_ack_invalid");
  const provider = createChromeNativeProvider({
    async exchange(message) {
      const requestId = crypto.randomUUID();
      writeMessage({ ...message, requestId });
      for (;;) {
        const response = await nextMessage();
        if (response?.requestId !== requestId) continue;
        if (response?.type === "collection_error") {
          const error = new Error(safeCode(response?.code || "native_host_collection_failed"));
          error.code = safeCode(response?.code || "native_host_collection_failed");
          throw error;
        }
        return response;
      }
    },
  });
  const summary = await runLocalShoppingWorker({
    provider,
    queueAllTrackers: WHOLE_SITE_QUEUE_TRIGGERS.has(start.trigger),
    requireWakeSignal: start.trigger === "rank-remote",
    log(event) {
      process.stderr.write(`${safeCode(event)}\n`);
    },
  });
  writeMessage({ type: "summary", summary });
}

main().catch((error) => {
  writeMessage({ type: "error", code: safeCode(error) });
  process.exitCode = 1;
});
