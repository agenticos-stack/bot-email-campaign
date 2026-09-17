// In-memory fixture for the disconnected preview — a synthetic
// `globalThis.gadget` answering the Email Campaign facet's method surface.
// Nothing here calls a real connector, sender, or platform; send and grant
// actions answer the values a refused-or-pending door would, so the canvas
// exercises every state without a live path.
globalThis.RpcTarget = class {};

const params = new URL(location.href).searchParams;
const withCaps = (key) => params.get(key) !== "0" && params.get(key) !== "off";

const seg = { segment_id: "seg_active", label: "Active members" };
const seedSections = () => [
  { id: "s_1", type: "heading", heading: "A little more room for what you love." },
  { id: "s_2", type: "body", body: "Hello there,\n\nA new season is a good reason to make time for yourself. Our September workshops are now open." },
  { id: "s_3", type: "cta", cta_label: "Explore September workshops", cta_url: "https://example.com/workshops" }
];

let revision = 12;
const draft = {
  title: "September members’ edit",
  audience_source: "segment",
  audience_segment: [seg],
  audience_accounts: [],
  audience_exclusions: [{ kind: "campaign", id: "pc_1", label: "September welcome series" }],
  subject: "A new season, a little something for you",
  preheader: "Your first look at what is coming this month.",
  sections: seedSections(),
  scheduled_for: ""
};

const campaign = {
  id: "cmp_autumn",
  title: draft.title,
  draft: JSON.parse(JSON.stringify(draft)),
  revision,
  status: "draft",
  estimate: { key: "", total: 1248, excluded: 24, missing: 18, consent: 94, opted: 14, eligible: 1098 },
  estimateKey: "",
  outcome: null,
  savedFingerprint: "",
  createdAt: "2026-09-16T09:42:00.000Z",
  updatedAt: "2026-09-16T09:42:00.000Z"
};
// The fixture's own audience key, matching model.js's shape — tolerant of a
// partial draft (a save may carry only the fields that changed).
const audKey = (d) => JSON.stringify({ source: d.audience_source ?? "all", segment: (d.audience_segment ?? []).map((s) => s.segment_id).sort(), accounts: (d.audience_accounts ?? []).map((a) => a.account_id).sort(), exclusions: (d.audience_exclusions ?? []).map((e) => `${e.kind}:${e.id}`).sort() });
campaign.estimate.key = audKey(campaign.draft);
campaign.estimateKey = campaign.estimate.key;

// `?empty=1` seeds no campaigns — with every capability off (`favcrm=0…`) that
// is the first-run state that lands the canvas on the setup view.
const campaigns = params.get("empty") === "1" ? [] : [campaign];

globalThis.gadget = {
  async summary() { return { ok: true, campaigns: campaigns.map((c) => ({ id: c.id, title: c.title, status: c.status, subject: c.draft.subject, revision: c.revision, updatedAt: c.updatedAt })), capabilities: this._caps(), selectedCampaignId: campaign.id }; },
  _caps() {
    return {
      favcrm_connector: { granted: withCaps("favcrm"), interim: false },
      email_sender: { granted: withCaps("sender"), interim: false },
      schedule: { granted: withCaps("schedule"), interim: false },
      workspace: { granted: withCaps("workspace"), interim: false }
    };
  },
  async getCapabilities() { return { ok: true, capabilities: this._caps(), grants: {} }; },
  async refreshGrants() { return this.getCapabilities(); },
  async setConfig() { return { ok: true, config: {} }; },
  async listCampaigns() {
    return { ok: true, drafts: campaigns.map((c) => JSON.parse(JSON.stringify(c))), siblings: [], history: { campaigns: [] }, capabilities: this._caps() };
  },
  async getCampaign(id) { const c = campaigns.find((x) => x.id === id); return c ? { ok: true, campaign: JSON.parse(JSON.stringify(c)) } : { ok: false, code: "not_found", message: "No such campaign draft." }; },
  async getDraft(input = {}) {
    const c = input.id ? campaigns.find((x) => x.id === input.id) : campaign;
    if (!c) return { ok: false, code: "not_found", message: "No campaign draft yet." };
    return { ok: true, campaign: JSON.parse(JSON.stringify(c)), draft: c.draft, estimateStale: c.estimateKey !== audKey(c.draft), missing: [] };
  },
  async getReview(input = {}) { const r = await this.getDraft(input); return r.ok ? { ok: true, ...r, estimate: r.campaign.estimate, outcome: r.campaign.outcome, savedFingerprint: r.campaign.savedFingerprint, capabilities: this._caps() } : r; },
  async exportDraft(input = {}) { const r = await this.getDraft(input); return r.ok ? { ok: true, campaignId: r.campaign.id, revision: r.campaign.revision, fingerprint: "", fields: r.campaign.draft } : r; },
  async previewHtml() { return { ok: true, html: "" }; },
  async createCampaign() {
    const c = { id: `cmp_${campaigns.length}`, title: "", draft: { audience_source: "all", audience_segment: [], audience_accounts: [], audience_exclusions: [], subject: "", preheader: "", sections: [], scheduled_for: "" }, revision: 0, status: "draft", estimate: null, estimateKey: "", outcome: null, savedFingerprint: "", createdAt: "", updatedAt: "" };
    campaigns.unshift(c);
    return { ok: true, campaign: JSON.parse(JSON.stringify(c)) };
  },
  async saveDraft(input = {}) {
    const c = campaigns.find((x) => x.id === input.id);
    if (!c) return { ok: false, code: "not_found", message: "No such campaign draft." };
    if (input.expectedRevision != null && input.expectedRevision !== c.revision) return { ok: false, code: "revision_conflict", message: "A newer fixture revision exists." };
    // A draft save merges the incoming fields over the stored draft — the
    // client sends the working copy, but a partial update must not drop the
    // audience it never touched.
    c.draft = { ...c.draft, ...JSON.parse(JSON.stringify(input.draft ?? {})) };
    if (typeof input.title === "string") c.title = input.title;
    c.revision += 1;
    c.estimateKey = audKey(c.draft);
    return { ok: true, campaign: JSON.parse(JSON.stringify(c)), revision: c.revision };
  },
  async applyCommand(input = {}) { const c = campaigns.find((x) => x.id === input.campaignId); if (!c) return { ok: false, code: "not_found", message: "No such campaign draft." }; if (input.expectedRevision != null && input.expectedRevision !== c.revision) return { ok: false, code: "revision_conflict", message: "A newer fixture revision exists." }; const cmd = input.command ?? {}; if (cmd.kind === "state.set" && typeof cmd.path === "string") c.draft[cmd.path] = cmd.value; c.revision += 1; return { ok: true, campaign: JSON.parse(JSON.stringify(c)), revision: c.revision }; },
  async selectCampaign() { return { ok: true }; },
  async deleteCampaign(input = {}) { const i = campaigns.findIndex((x) => x.id === input.id); if (i >= 0) campaigns.splice(i, 1); return { ok: true }; },
  async listProposals() { return { ok: true, proposals: params.get("proposal") === "1" ? [{ id: "pp_1", campaignId: campaign.id, kind: "draft", payload: { commands: [] }, label: "A clearer subject line for this audience.", baseRevision: campaign.revision, state: "pending", createdAt: "" }] : [] }; },
  async proposeChange() { return { ok: true, proposalId: "pp_1" }; },
  async acceptProposal() { return { ok: true, campaign: JSON.parse(JSON.stringify(campaign)) }; },
  async rejectProposal() { return { ok: true }; },
  async getSenderStatus() { return { ok: true, sender: withCaps("sender") ? { connected: true, provider: "resend", from_email: "hello@northstar.example", from_name: "Northstar Studio" } : null }; },
  async listSegments() { return { ok: true, segments: [{ segment_id: "seg_active", label: "Active members" }, { segment_id: "seg_return", label: "Returning customers" }, { segment_id: "seg_fresh", label: "New this month" }] }; },
  async searchAccounts(input = {}) {
    const q = (input.query ?? "").toLowerCase();
    const all = [{ account_id: "c1", name: "Jamie Chan", email: "jamie@example.com" }, { account_id: "c2", name: "Alex Wong", email: "alex@example.com" }, { account_id: "c3", name: "Morgan Lee", email: "morgan@example.com" }];
    return { ok: true, accounts: all.filter((a) => `${a.name} ${a.email}`.toLowerCase().includes(q)) };
  },
  async getSchedules() { return { ok: true, schedules: [] }; },
  async refreshEstimate() { campaign.estimateKey = audKey(campaign.draft); campaign.estimate.key = campaign.estimateKey; return { ok: true, estimate: campaign.estimate }; },
  // Sends answer the interim reality: no real connector or sender exists.
  async sendTest() { return { ok: false, code: "capability_unavailable", door: "favcrm_connector", message: "Fixture preview — no connector is connected." }; },
  async sendNow() { return { ok: false, code: "capability_unavailable", door: "favcrm_connector", message: "Fixture preview — no connector is connected." }; },
  async scheduleSend() { return { ok: false, code: "capability_unavailable", door: "favcrm_connector", message: "Fixture preview — no connector is connected." }; },
  async undoSend() { return { ok: true }; },
  async refreshCampaignStatus() { return { ok: true, campaign: JSON.parse(JSON.stringify(campaign)) }; },
  async verifySender() { return { ok: true, result: { verified: true } }; },
  async subscribe() { return { ok: true }; }
};
