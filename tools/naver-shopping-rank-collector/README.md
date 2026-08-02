# Moment N Shopping Local Collection Engine

This package is the local collection engine used by Moment Insight's signed
N Shopping worker. It is not a public HTTP service, a Render service, or a
container deployment target.

## Safety contract

- Node.js 20 or newer with the exact pinned Playwright dependency.
- Request/response schema: `mi.naver-shopping-organic-window.v1`.
- One immutable `collectionId` and `collectedAt` must contain the complete,
  contiguous organic rank window.
- Exactly 300 rows are required for the production local-worker submit path.
- Explicit ads, duplicate identities, rank gaps, mixed evidence, stale data,
  and partial pages fail closed without changing the stored rank or history.
- `marketTotal` is optional and never substitutes for organic rank evidence.
- Only the fixed dedicated profile under
  `$HOME/Library/Application Support/MomentInsight/NaverShoppingProfile` is
  accepted. Personal Chrome profiles and arbitrary paths are rejected.
- The user completes Naver authentication or security confirmation directly in
  the visible browser. The code never reads passwords, exports cookies or
  storage state, or automates CAPTCHA solving.

## Runtime ownership

The root worker script `scripts/naver-shopping-local-worker.mjs` validates the
profile before claiming a live job. It submits results to the application with
HMAC, a bounded timestamp and a one-time nonce. The server commits the tracker
and snapshot through service-role-only atomic RPCs.

The server-side mobile fallback remains independent and can verify exact hits
only inside its contiguous top window. It never turns a miss outside that
window into a confirmed not-found result.

## Verification

```bash
npm run check
npm test
```

A successful unit test is not live 300-rank proof. Production proof requires a
recent `pw-*` snapshot with `checked_count=300` and the same collection ID for
all tracker updates produced from that keyword window.
