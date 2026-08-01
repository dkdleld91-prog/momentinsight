import { createCollectorServer } from "./app.mjs";
import { createProviderFromEnv } from "./provider.mjs";

const port = Number(process.env.PORT || 8798);
const host = String(process.env.HOST || "127.0.0.1").trim();
const secret = String(process.env.NAVER_SHOPPING_RANK_COLLECTOR_SECRET || "");
const provider = createProviderFromEnv(process.env);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("invalid_port");
}

const server = createCollectorServer({ secret, provider });
server.requestTimeout = 230_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Moment Naver Shopping rank collector stopping (${signal})`);
  await new Promise((resolve) => server.close(resolve));
  await provider.close?.().catch(() => {});
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

server.listen(port, host, () => {
  console.log(`Moment Naver Shopping rank collector listening on ${host}:${port}`);
});
