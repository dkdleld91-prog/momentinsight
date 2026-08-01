# Moment N Shopping Organic Rank Collector

This is an isolated Playwright collector for one atomic N Shopping organic-rank
window. It fails closed whenever Naver blocks access or the full requested
window cannot be proven.

## Safety contract

- Node.js 20 or newer.
- `POST /rank/naver-shopping` requires a Bearer secret.
- Request/response `schemaVersion`: `mi.naver-shopping-organic-window.v1`.
- One response represents one immutable collection (`collectionId`,
  `collectedAt`) rather than stitched page calls.
- Only `naver_shopping_results_collector` with
  `naver_shopping_organic_list` evidence is accepted.
- Incomplete, malformed, mixed-source, or advertisement-contaminated windows
  are rejected. No rank is fabricated or saved from them.
- Rank coverage and the optional market-total capability are independent.
  `marketTotalStatus=verified` carries a proven integer total; otherwise the
  response keeps the complete rank window with `marketTotal=null` and
  `marketTotalStatus=unavailable` rather than inventing a product count.
- Responses use `Cache-Control: no-store`; CORS is intentionally not enabled.
- `/health` is process liveness. `/ready` is `200` only when the secret and a
  configured, verified provider adapter are both present.

## Playwright provider

Set `NAVER_SHOPPING_PROVIDER_MODE=playwright`. The provider keeps one browser,
opens an isolated context per job, serializes collection with a bounded queue,
and coalesces/cache-reuses the same keyword window. It constructs only the
allow-listed `https://search.shopping.naver.com/search/all` relevance URL.
Headless collection uses Playwright's official `chromium` channel (the current
Chromium headless implementation) while retaining a fresh anonymous context for
every job. It does not inject credentials, stealth patches, fingerprint
spoofing, or challenge-bypass behavior.

Before assigning `organicRank`, it removes explicit advertisements and rejects
duplicate identities. HTTP 418/429, CAPTCHA, login redirects, selector drift,
deadline expiry and partial coverage are typed failures.

Queue capacity and queued-caller deadline failures are request-local and do not
invalidate an already verified provider. Live Naver/source failures still
invalidate readiness immediately.

At startup the provider runs a bounded live canary. `/ready` stays `503` until
that canary produces a complete response that passes the same contract used by
the application. A green process `/health` is therefore never treated as proof
that live ranks can be collected.

## Local verification

```bash
npm run check
npm test
```

## Container

The Docker image uses the matching Playwright Chromium image, runs as the
non-root `pwuser`, and exposes port `8798`.
