# Working on Email Campaign

This repository is the single source of truth for the Email Campaign gadget:
`definition.ts`, `src/` (server, storage, model, config, doors, and the client
under `src/src/client/`), and the build that produces `email-campaign.gadget`.
The API monorepo vendors the built archive with recorded provenance; it does
not hold the source any more.

## What the gadget does

`audience → content → review & send`

Compose governed bulk-email campaigns: audience references (segment id,
account ids, exclusion ids — never a materialized recipient list), typed
content sections (`heading | body | cta | image`) plus a sanitized
`custom_html` escape hatch for editor-exported markup, then an
owner-approved send. FavCRM owns customers, consent, opt-outs, unsubscribe
and the queue; this object is the AgenticOS-facing draft and decision record.

## The three ways to run it, and what each can actually do

| mode | data | doors | use it for |
| --- | --- | --- | --- |
| `fixture` | synthetic | none | components, layout, copy |
| `local-runtime` | seeded local SQLite | none | storage, model, client logic |
| `connected-prod` | real org, real model | **granted doors** | the whole loop |

Only the third can reach a real connector or sender, because those go
through doors and a door is a platform object. The first two are faster and
cost nothing — use them for anything that does not need one.

```sh
# fixture / local
pnpm preview

# connected: real production agent loop, local source
bot-dev login                       # once, ever
bot-dev dev --gadget email_campaign --org <sandbox-org> -- pnpm preview
```

`bot-dev` comes from `@agenticos-dev/bot-devkit`. It mints an eight-hour
session, starts this host with it, and prints which doors are reachable.
`BOT_SDK_SOURCE` must point at an `agenticos-bot-sdk` checkout.

## Before a connected run

1. **Use a sandbox org, not a customer's.** Turns debit real credits
   (`V2_TURN_BILLING` is on in production).
2. **Grant the doors on that conversation.** `schedule` and `workspace`
   resolve today; `favcrm_connector` and `email_sender` are declared but
   have no platform door kind yet — they answer a capability gap rather
   than pretending, and the send path stays host-side until they land. An
   ungranted door is ABSENT from `env`, not refused, and the gadget reads
   that absence as configuration rather than failure.
3. **Archiving the `[gadget-dev]` conversation revokes everything**: the
   session, the doors and the socket, in one act.

## What is true about governance, so you do not design around a myth

- A gadget can NEVER send, spend, operate or deploy directly. Those refuse
  with `submission_required`, installed or not. A send is an approval the
  owner grants; the platform composes the effect from the pinned revision.
  That is not a development restriction.
- `read` and `generate` proceed, scoped and audited. Estimating an audience
  is a read.
- Every door call is recorded, including from a development session.

## Where to start

The campaign-delivery bridge stays host-side initially
(`workers/api/src/domains/campaigns/service.ts` in the API monorepo): the
facet owns the draft and command surface, the API service owns the FavCRM
mirror and the send. Migrating operations behind real door contracts is the
declared direction — when `favcrm_connector`/`email_sender` gain real door
kinds, the facet's honest capability gap becomes a bound door without a
contract change.

## Traps that have already cost someone a day

- **Two test runners.** `test/*.test.mjs` is `node --test` (host behaviour);
  `test/unit/**` is vitest (gadget internals, ported from the API). `npm test`
  runs both. Consolidating them is real work nobody has done.
- **`src/client.js` is generated and gitignored.** The client source is
  `src/src/client/*.js`; `build.mjs` bundles it on every build. A committed
  bundle silently drifts — one used to, and a test asserted against it.
- **zh-HK means written Chinese.** `嘅 咗 唔 呢個 睇 喺` belong in speech, not
  in a product. `test/unit/model.test.ts` and the i18n tests enforce this.
- **The archive is vendored into the API.** After changing anything that ships,
  rebuild and re-sync there, or the platform keeps serving the old gadget.
- **Do not add a second send, schedule, approval or stats lifecycle.** The
  campaigns bridge and FavCRM own those; the definition's `actions` bind the
  platform's gated catalog entries and nothing else.

## Checks before a PR

```sh
pnpm build          # archive builds, prints size and sha256
npm test            # host suite + unit suite
```

PRs go to `staging`.
