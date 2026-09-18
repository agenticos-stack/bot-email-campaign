# Email Campaign AI agent

Public source: `agenticos-stack/bot-email-campaign`. Licensed under Apache-2.0.
Standalone app repository; `private: true` prevents accidental npm publication
and does not restrict this repository's open-source license.

## Branch line

`staging` is the integration branch — feature work branches from
`origin/staging` and PRs back to it (`gh pr create --base staging`). Never
commit or push on `main`/`staging` directly. `main` is the production line,
promoted from a tested staging SHA.

## The platform chain — where things live

- **Author the agent here**, then build a portable `.gadget` archive:
  `pnpm install --frozen-lockfile --ignore-scripts && pnpm test && pnpm build && pnpm validate`.
- **The SDK owns shared machinery.** `@agenticos-dev/bot-devkit` (build,
  validate, dev sessions), `@agenticos-dev/bot-testkit` (local runtime,
  fixtures), `@agenticos-dev/bot-shell` (canvas client layer) and
  `@agenticos-dev/bot-archive-tools`/`bot-contract` are consumed as npm
  **dependencies**. When a script needs something the SDK lacks, extend the
  SDK package and publish — never fork a local copy. See `sdk/AGENTS.md`,
  "Why the bots forked devkit".
- **The API consumes the built archive** through the provenance-tracked
  vendor sync: `pnpm sync:email-campaign --from <this checkout>` in
  `agenticos` (the API monorepo). Never hand-edit
  `packages/email-campaign-vendor/`; `--check` gates drift.
- **Sequence for SDK changes**: sdk PR → publish → bump this repo's
  dependency → rebuild → re-vendor into the API.

## Local rigs

- `pnpm preview` serves the in-memory fixture canvas (no API, no build).
- `EMAIL_CAMPAIGN_PREVIEW_MODE=local-runtime pnpm preview` runs the real
  facet against local SQLite; state persists under `.bot-local/`. The
  local-runtime host tests need `BOT_SDK_SOURCE` pointing at an
  `agenticos-bot-sdk` checkout ≥ `ae1742e` (testkit `maxRequestBytes`).

## Byte budgets are ratchets

`scripts/build.mjs` pins `CLIENT_JS_BYTE_BUDGET` (the authoring store's
156,000-byte read ceiling) and `ARCHIVE_BYTE_BUDGET` (a growth ratchet at the
measured size). A trip is a deliberate bump in the diff, with a comment saying
what the guard protects.
