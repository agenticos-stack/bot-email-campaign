/**
 * `email_campaign@1` — a governed bulk-email work object.
 *
 * Delivery is delegated: FavCRM owns customers, segments, consent, opt-outs,
 * unsubscribe, and the queue. This object is the AgenticOS-facing draft and
 * decision record — the agent fills audience + content through commands, the
 * domain service mirrors it into a FavCRM campaign row, and `send`/`schedule`
 * bind to gated catalog entries so an owner always decides.
 *
 * Things worth reading before changing it:
 *
 * 1. `mutable` covers audience and content only. `favcrm_campaign_id`,
 *    `estimate`, `delivery_stats` and `review_state` are written by the domain
 *    service as outcomes — an agent must not be able to mark its own draft
 *    approved or claim a send happened.
 * 2. The audience stores REFERENCES (segment id, account ids, exclusion ids)
 *    with display labels beside them — never a materialized recipient list.
 *    Eligibility is re-derived at send time by FavCRM's single funnel.
 * 3. `estimate`/`delivery_stats` are collections of {metric, value} rows so a
 *    declarative view can render them without a bespoke widget type.
 * 4. Sections are typed blocks — `heading | body | cta | image` — plus the
 *    `custom_html` escape hatch: one pasted block (a whole exported email from
 *    Stripo/BEE/Mailchimp-style editors, or a single block). `custom_html`
 *    carries `html`; sanitization is a send-time boundary in the domain
 *    service (`sectionsToHtml` / the FavCRM mirror), never a definition or
 *    command concern — and the platform still appends sender identity, legal
 *    footer and unsubscribe on every send, which no section can remove.
 */

import { GADGET_DEFINITION_SCHEMA } from "@agenticos-dev/bot-contract";

export const EMAIL_CAMPAIGN_DEFINITION = {
  schemaVersion: GADGET_DEFINITION_SCHEMA,
  key: "email_campaign",
  version: 1,
  title: "Email campaign",
  runtimeTier: "declarative",

  fields: [
    // --- audience: references + resolved display labels ---
    { key: "audience_source", kind: "choice", label: "Audience", options: ["all", "segment", "individual"] },
    // At most one row: [{ segment_id, label }]
    { key: "audience_segment", kind: "collection", label: "Segment", maxItems: 1 },
    // [{ account_id, name, email }]
    { key: "audience_accounts", kind: "collection", label: "Selected customers", maxItems: 500 },
    // [{ kind: "account" | "campaign", id, label }]
    { key: "audience_exclusions", kind: "collection", label: "Exclusions", maxItems: 500 },

    // --- content ---
    { key: "subject", kind: "text", label: "Subject" },
    { key: "preheader", kind: "text", label: "Preheader" },
    // [{ type: "heading" | "body" | "cta" | "image" | "custom_html",
    //    heading?, body?, cta_label?, cta_url?, image_url?, html? }]
    { key: "sections", kind: "collection", label: "Email sections", maxItems: 40 },

    // --- schedule: empty means "send on approval" ---
    { key: "scheduled_for", kind: "text", label: "Scheduled for" },

    // --- outcomes: written by the domain service, never by command ---
    { key: "review_state", kind: "choice", label: "Review", options: ["drafting", "in_review", "approved", "sent"] },
    { key: "favcrm_campaign_id", kind: "text", label: "FavCRM campaign" },
    // [{ metric, value }] — e.g. total, excluded, no_consent, opted_out, eligible
    { key: "estimate", kind: "collection", label: "Audience estimate", maxItems: 12 },
    // [{ metric, value }] — e.g. sent, delivered, opened, clicked, bounced, failed
    { key: "delivery_stats", kind: "collection", label: "Delivery stats", maxItems: 12 },
    // [{ connected, provider, from_email }] — sender readiness snapshot
    { key: "sender_status", kind: "collection", label: "Sender", maxItems: 4 },
    { key: "approvals", kind: "collection", label: "Approvals", maxItems: 20 },
    { key: "proposals", kind: "collection", label: "Pending changes", maxItems: 50 }
  ],

  /**
   * The allowlist. Everything absent here — campaign binding, estimate, stats,
   * review state — is unreachable by any caller through any surface.
   */
  mutable: [
    "audience_source",
    "audience_segment",
    "audience_segment[].segment_id",
    "audience_segment[].label",
    "audience_accounts",
    "audience_accounts[].account_id",
    "audience_accounts[].name",
    "audience_accounts[].email",
    "audience_exclusions",
    "audience_exclusions[].kind",
    "audience_exclusions[].id",
    "audience_exclusions[].label",
    "subject",
    "preheader",
    "sections",
    "sections[].type",
    "sections[].heading",
    "sections[].body",
    "sections[].cta_label",
    "sections[].cta_url",
    "sections[].image_url",
    "sections[].html",
    "scheduled_for"
  ],

  commands: [
    "state.set",
    "state.merge",
    "collection.add",
    "collection.update",
    "collection.remove",
    "selection.set",
    "proposal.accept",
    "proposal.reject"
  ],

  actions: [
    {
      // Gated — the catalog entry decides, the definition cannot (SEC-005).
      actionKey: "send",
      catalogEntryId: "workflow-run",
      label: "Send campaign",
      outputMapping: "outputs"
    },
    {
      actionKey: "schedule",
      catalogEntryId: "workflow-run",
      label: "Schedule campaign",
      outputMapping: "outputs"
    },
    {
      actionKey: "send_test",
      catalogEntryId: "workflow-run",
      label: "Send test email",
      inputSchema: {
        type: "object",
        properties: { to: { type: "string", format: "email" } },
        required: ["to"],
        additionalProperties: false
      },
      outputMapping: "outputs"
    }
  ],

  views: [
    {
      key: "campaign",
      label: "Campaign",
      layout: "measured",
      widgets: [
        { id: "audience", type: "collection_table", title: "Audience", binding: "audience_accounts", columns: ["name", "email"], visibleWhen: { field: "audience_source", op: "eq", value: "individual" } },
        { id: "segment", type: "collection_table", title: "Segment", binding: "audience_segment", columns: ["label"], visibleWhen: { field: "audience_source", op: "eq", value: "segment" } },
        { id: "exclusions", type: "collection_table", title: "Exclusions", binding: "audience_exclusions", columns: ["kind", "label"] },
        { id: "estimate", type: "collection_table", title: "Eligibility", binding: "estimate", columns: ["metric", "value"] },
        { id: "content", type: "collection_table", title: "Content", binding: "sections", columns: ["type", "heading", "body"] },
        { id: "pending", type: "proposal_list", title: "Pending changes", binding: "proposals" },
        { id: "approval", type: "approval", title: "Approval", binding: "review_state", visibleWhen: { field: "review_state", op: "ne", value: "drafting" } },
        { id: "actions", type: "action_bar", title: "Actions" }
      ]
    },
    {
      key: "delivery",
      label: "Delivery",
      layout: "full",
      widgets: [
        { id: "stats", type: "collection_table", title: "Delivery stats", binding: "delivery_stats", columns: ["metric", "value"] },
        { id: "sender", type: "collection_table", title: "Sender", binding: "sender_status", columns: ["provider", "from_email", "connected"] }
      ]
    }
  ],

  requirements: [
    /*
     * INTERIM (platform door kinds pending): `favcrm_connector` and
     * `email_sender` name the capabilities send/estimate depend on, but no
     * gatekeeper kind maps to them yet — a grant request finds no door to
     * open, and `env.<key>` is absent, so the facet answers a capability gap
     * instead of pretending. The declared intent is kept so the contract is
     * already correct when the real doors land. Do not wire fake doors.
     */
    { requirementKey: "favcrm_connector", kind: "connector_resource", label: "FavCRM workspace (customers, segments, consent, delivery)", optional: true },
    { requirementKey: "email_sender", kind: "capability", label: "Email sender (ESP)", optional: true },
    // Real door kinds today: `schedule` arms send times, `workspace` lists
    // sibling gadgets (the campaign list) and posts notifications.
    { requirementKey: "schedule", kind: "capability", label: "Campaign scheduling", optional: true },
    { requirementKey: "workspace", kind: "capability", label: "Workspace notifications", optional: true }
  ]
} as const;

/** Starting state — empty audience and content, nothing invented. */
export const EMAIL_CAMPAIGN_INITIAL_STATE = {
  audience_source: "all",
  audience_segment: [],
  audience_accounts: [],
  audience_exclusions: [],
  subject: "",
  preheader: "",
  sections: [],
  scheduled_for: "",
  review_state: "drafting",
  favcrm_campaign_id: "",
  estimate: [],
  delivery_stats: [],
  sender_status: [],
  approvals: [],
  proposals: []
};
