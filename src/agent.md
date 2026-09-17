# Working this gadget

You reach this gadget only through `readGadget` and `callGadgetMethod` — the
same two tools every gadget uses. There is no Email Campaign tool. Call
`readGadget` (or the facet's `getDraft`/`getReview`) first when you are unsure
what a campaign draft holds; its answer is always current, never assumed from
an earlier turn.

## What this gadget is

One Email Campaigns gadget is the owner-facing workbench for bulk email: it
holds campaign drafts, walks a three-step composer (audience → content →
review & send), and hands an approved send to the platform's campaigns
service through the `favcrm_connector` door. FavCRM owns customers, segments,
consent, opt-outs, unsubscribe and the delivery queue — this gadget never
materializes a recipient list and never delivers mail itself.

## The draft, and how you edit it

Each campaign is a row in the facet's own storage (`campaigns`), shaped by
`model.js`'s `normalizeDraft`:

- `audience_source` — `all`, `segment`, or `individual`.
- `audience_segment` — at most one `{ segment_id, label }` reference.
- `audience_accounts` — `[{ account_id, name, email }]` references, never a
  materialized recipient list.
- `audience_exclusions` — `[{ kind: "account"|"campaign", id, label }]`.
- `subject`, `preheader` — text.
- `sections` — typed blocks: `heading`, `body`, `cta` (`cta_label` +
  `cta_url`), `image` (`image_url`), and `custom_html` (`html`).
- `scheduled_for` — an ISO time, or empty for "send on approval".

Edit a draft through `callGadgetMethod` with the command surface
(`applyCommand` with `state.set` / `collection.add` / `collection.update` /
`collection.remove`, or `saveDraft` for a whole-draft save). Both take an
`expectedRevision` — read first so your write is against the current draft,
not a stale one; a conflict is returned, never thrown.

The mutable boundary is enforced: `review_state`, `favcrm_campaign_id`,
`estimate`, `delivery_stats`, `sender_status` and `approvals` are outcomes the
domain service owns. No command you can send writes them.

## `custom_html` — the paste escape hatch

A `custom_html` section carries pasted markup — a whole exported email or a
single block from Stripo/BEE/Mailchimp-style editors. When you propose one,
the payload is a **whole-block replacement** (a `collection.update` on the
section's `html`), never a merge of pasted markup into typed sections. The
markup is sanitized at the send boundary — scripts, forms, tracking pixels,
inline `on*` handlers and `javascript:` URLs are removed — and the platform
still appends sender identity, the legal footer and unsubscribe handling to
every send; no section you write can remove them. Do not write merge tags;
they do not render in this batch.

## Proposals — ask before you overwrite

When you draft or rewrite content the owner has not asked you to apply
directly, stage it as a proposal (`proposeChange`) — a labelled command batch
the owner accepts or rejects in the canvas. `acceptProposal` applies the batch
as one revision; `rejectProposal` retires it. A proposal is the honest shape
of "I prepared this for you" — it is not an approval to send.

## Sending — always the owner's decision

`send`, `schedule` and `send_test` are governed actions that reach the
campaigns domain service through the `favcrm_connector` door. They require the
connector and a verified sender; when either is absent the facet answers a
`capability_unavailable` gap and the owner grants it (or cannot yet — the door
kinds are interim). Never claim a send happened, never mark a draft approved
yourself, and never send without the owner's explicit approval. An audience
change invalidates the estimate — refresh it (`refreshEstimate`) before asking
for approval. An edit after approval requires fresh approval; approval binds
the exact saved revision (`draftFingerprint`), so a draft that moved is a
draft that must be re-reviewed.
