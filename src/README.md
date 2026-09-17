# Email Campaign

A governed bulk-email workbench: it holds campaign drafts, walks a three-step
composer (audience → content → review & send), and hands an approved send to
the platform's campaigns service through the `favcrm_connector` door. FavCRM
owns customers, segments, consent, opt-outs, unsubscribe and the delivery
queue — this gadget never materializes a recipient list and never sends mail
itself.

This gadget carries no product-specific code, table, or route on the host
platform. Everything it does — the draft store, the composer, the command
surface, the proposal and approval flows — is code and data inside this
archive. The platform lends it capabilities through the doors below and never
learns this blueprint's name.

## Files

Flat, per the runtime's contract: no bundler, no subdirectories, relative
imports between these files resolved by the runtime itself.

| File | What it is |
| --- | --- |
| `client.js` | The sandboxed UI — the campaign list, three-step composer, door strip, proposals, review & send, EN/zh-HK. Bundled from `src/client/*` (not shipped raw). |
| `server.js` | The facet class: the campaign-draft store, the command surface, the door calls, and every method the client and the agent reach. |
| `storage.js` | The SQLite adapter `server.js` uses — the one place table names and columns are named. |
| `config.js` | Instance configuration: display defaults and estimate policy. |
| `doors.js` | Every door call in one place — a contract change on a door touches this file, not every method that happens to use it. |
| `model.js` | Pure functions with no I/O: draft normalization, the `mutable` allowlist, the `mutableWhen` lifecycle lock, the `custom_html` refusal boundary, command application. Unit-testable outside the runtime. |
| `grant-request.js` | The `gadget:grant-door` / `gadget:activate-door` / `gadget:grant-result` / `gadget:doors-changed` postMessage contract between the sandboxed canvas and its host. |
| `agent.md` | Working instructions for the agent that drafts and proposes here. |
| `README.md` | This file. |

## The draft, and where it lives

The composer's working draft lives in this facet's own Durable Object storage
(`campaigns`, in `ctx.storage.sql`) — never read or mirrored by the host. The
gadget's declarative `state_json` remains the governed record the campaigns
domain service reads for send; the facet cannot write it, so the send path
carries the draft **through the `favcrm_connector` door**, which mirrors it
into `state_json` before filing the governed action. Until that door kind
lands, the calls answer a capability gap — see Interim doors below.

## Doors

Declared in `definition.ts` and called only through `doors.js`:

| Requirement | Kind | Real today? | What it does |
| --- | --- | --- | --- |
| `favcrm_connector` | `connector_resource` | **Interim** | Segments, customers, estimates, campaign mirror, sends — the send bridge. |
| `email_sender` | `capability` | **Interim** | The verified sender identity campaigns are sent from. |
| `schedule` | `capability` | Yes | Arm/cancel a send time. |
| `workspace` | `capability` | Yes | List sibling gadgets (the campaign list) and post notifications. |

`favcrm_connector` and `email_sender` name the capabilities send and estimate
depend on, but no gatekeeper kind maps to them yet — a grant request finds no
door to open and `env.<key>` is absent, so the facet answers a
`capability_unavailable` gap instead of pretending. Drafting stays editable;
sending stays blocked until granted. In `connected` dev mode the rig injects
a loopback implementation of this exact surface backed by the local API's
campaigns routes, so the journeys exercise the real domain service.

## The sections model

Content is typed blocks — `heading`, `body`, `cta`, `image` — and nothing
else. There is no raw-HTML escape hatch: pasted markup (a whole exported
email from Stripo/BEE/Mailchimp-style editors, or a single block) is refused
at the draft write boundary with `unsupported_section`, because neither the
gadget runtime nor the host send path has a parser-based sanitizer to carry
it safely. The platform still appends sender identity, the legal footer and
unsubscribe handling on every send; the editor cannot remove them.

## Testing

`pnpm build` packs the archive and `pnpm validate` checks it; `pnpm test`
runs the host (tsx) and unit (vitest) suites — command surface, proposal
accept/reject, the `custom_html` refusal boundary and the `mutableWhen`
lifecycle lock are covered.
