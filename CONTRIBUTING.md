# Contributing

`stellar-agent-guard-dashboard` is the operator console: a pure client-side Next.js app
that holds no keys and runs no server code, so most changes are UI, client-side Soroban
RPC, or tests.

## Shared conventions

Commit style, the one-commit-per-logical-unit **per file** rule, the branch lifecycle
(feature branch → PR → delete after merge, `main` only), and the issue label taxonomy are
defined once for this org in the
[`stellar-agent-guard-sdk` CONTRIBUTING.md](https://github.com/aigbagbobila/stellar-agent-guard-sdk/blob/main/CONTRIBUTING.md).
Read that first; this page only adds what is specific to the dashboard.

## Local gates before pushing

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # node --test (unit suite)
npm run test:e2e    # Playwright browser suites (npx playwright install chromium first)
npm run build       # Next.js production build
```

Three extra scripts are not part of the CI gate:

- `npm run prove:phase3` — re-runs the live testnet proof against the real deployed
  contract; needs funded testnet keypairs.
- `npm run inspect` — read-only dump of a deployed instance's on-chain state.
- `npm run test:perf` — the telemetry throughput benchmark (`tests/perf`, 10k
  events in 30s with FPS/heap assertions); frame-rate numbers depend on the
  runner's hardware, so it is measured locally and never gates a merge.

## Branch protection and CI

`main` is protected by the `main-protection` ruleset, and the required status check is
named exactly **`ci`**. The `ci` workflow runs typecheck, lint, the unit tests, the
production build, a dedicated step that re-checks the enforcement-scope statement in
`README.md` and `SPEC.md` against the canonical constant in `lib/guard/network.ts`
(`tests/unit/scopeStatement.test.ts`), and the Playwright end-to-end suites
(`npm run test:e2e`, headless Chromium against a mocked chain). Rewording the boundary fails CI, which is the
point — see [Enforcement scope](README.md#enforcement-scope--read-this-before-relying-on-the-caps).

## Keeping docs true to the code

Two documentation rules are part of the review, not optional polish:

- **README claims are tracked, not asserted.** The top-level `README.md` describes what the console can
do. Every behaviour claim there has a row in [`docs/readme-claims.md`](./docs/readme-claims.md) with
the file or test that evidences it. When you add, rename or remove a screen, panel, script or
capability bullet, update the matching row (and its "Last verified" date) in the same commit; a claim
with no evidence row is treated as a stale claim.
- **State-model changes update `SPEC.md`.** The derived-vs-stored table and the write-surface inventory
in [`SPEC.md` §8](./SPEC.md) are normative. If a change adds a persisted key, changes what is read from
the chain, adds a write path, or changes when a value refreshes, update that table in the same change —
the model and the code move together. This is this repo's adaptation of the contracts repo's "code and
spec co-move" rule to a client-side app.

## Supply chain

Workflow actions are pinned to full commit SHAs with a readable version comment, and every workflow
declares the least-privilege `permissions:` it needs. Do not replace a SHA pin with a moving tag, and
do not add a `uses:` without a pin. [`dependabot.yml`](./.github/dependabot.yml) opens the reviewable
bumps for both `github-actions` and `npm`.

## Issues

- Backlog: <https://github.com/aigbagbobila/stellar-agent-guard-dashboard/issues>
- The org-wide `tier:` / `scope:` label taxonomy is described in the shared
  CONTRIBUTING.md linked above; this repo's scope label is `scope:dashboard`.

