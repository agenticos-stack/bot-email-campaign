// Email Campaign blueprint — server.js, the facet.
//
// The facet class: storage (the campaign drafts), the command surface the
// client and the agent call, and the door calls send/estimate go through.
// Everything specific to this blueprint lives here and in its sibling files —
// nothing in `workers/api/src` names Email Campaign.
//
// FILE SHAPE (PAT-002): `model.js` is pure normalization/validation shared
// unchanged by client and server. `storage.js` is the one seam onto
// `ctx.storage.sql`. `config.js` is pure config validation. `doors.js` is
// every door call. This file wires them and is the only one that touches
// `this.ctx` or `this.env`.
//
// DRAFT STATE IN FACET STORAGE (kickoff 6837c). `campaigns` is the canvas's
// working store — the composer edits it through the command surface below.
// The gadget's `state_json` stays the governed mirror the campaigns domain
// service reads for send: the facet cannot write it (an isolate reaches only
// its own storage and granted doors), so the send path carries the draft
// THROUGH the `favcrm_connector` door (`doors.js`), which mirrors it into
// `state_json` before filing the governed action. Until that door kind lands
// the calls answer a capability gap — interim, and honest about it.
//
// REFUSAL VS THROW (output-gate fix, api PR #1496/#1502 CI evidence). This
// class runs as a `ctx.facets` target; every method call crosses a real
// Durable Object RPC boundary, and workerd logs "uncaught exception" for ANY
// exception that unwinds across it — even one a caller's try/catch handled —
// which is what breaks an actor's output gate during teardown. So a condition
// an owner can hit through ordinary use — a missing door, a stale revision, a
// campaign that is not there, a send that is not ready — answers with a VALUE
// (`{ ok: false, code, message }`), never a throw. A successful call keeps
// returning its bare value; `ok: false` is the only refusal marker.

import { DurableObject } from "cloudflare:workers";
import {
  applyCommandToDraft,
  audienceKey,
  draftFingerprint,
  draftLocked,
  draftToState,
  missingForSend,
  newId,
  normalizeDraft,
  normalizeSections,
  SECTION_TYPES,
  sectionsToHtml,
  unsupportedSectionTypes
} from "./model.js";
import { normalizeConfig, configIssues } from "./config.js";
import { Storage } from "./storage.js";
import {
  FIXED_DOOR_KEYS,
  INTERIM_DOOR_KEYS,
  doorGrantStatus,
  isDoorRefusal,
  listWorkspaceGadgets,
  notifyWorkspace,
  armSchedule,
  cancelSchedule,
  listSchedules,
  favcrmListSegments,
  favcrmSearchAccounts,
  favcrmEstimate,
  favcrmCampaignHistory,
  favcrmCampaignStatus,
  favcrmSendTest,
  favcrmSendNow,
  favcrmScheduleSend,
  favcrmUndoSend,
  emailSenderStatus,
  emailSenderVerify
} from "./doors.js";

export class Gadget extends DurableObject {
  static readMethods = [
    "summary",
    "getDraft",
    "getCampaign",
    "listCampaigns",
    "getCapabilities",
    "getReview",
    "listProposals",
    "exportDraft",
    "previewHtml",
    "getSchedules"
  ];

  constructor(ctx, env) {
    super(ctx, env);
    this.storage = new Storage(ctx);
    this.storage.migrate();
    this.subscribers = new Map();
    // RPC calls overlap at await points; mutations queue so each commits one
    // authoritative state in order (the workspace-docs serial lane).
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  now() {
    return new Date().toISOString();
  }

  // --- capabilities ---------------------------------------------------------

  /**
   * The capability snapshot the door strip renders: each declared door's
   * grant state, plus whether it is a real door kind today (a grant request
   * can open it) or an interim declaration (a grant request finds nothing to
   * grant — surfaced as "not available yet", honestly).
   */
  getCapabilities() {
    const grants = doorGrantStatus(this.env);
    const capabilities = {};
    for (const key of FIXED_DOOR_KEYS) {
      capabilities[key] = {
        granted: grants[key] === true,
        interim: INTERIM_DOOR_KEYS.includes(key)
      };
    }
    return { ok: true, capabilities, grants };
  }

  async refreshGrants() {
    const capabilities = this.getCapabilities();
    this.storage.setSession("capabilities", { at: this.now(), ...capabilities.capabilities });
    return capabilities;
  }

  // --- summary / list --------------------------------------------------------

  summary() {
    const campaigns = this.storage.listCampaigns();
    const capabilities = this.getCapabilities().capabilities;
    return {
      ok: true,
      campaigns: campaigns.map(campaignSummary),
      capabilities,
      selectedCampaignId: this.storage.getSession("selectedCampaignId") ?? null
    };
  }

  /**
   * The campaign list the canvas renders: this facet's own drafts (the working
   * store), plus — when granted — sibling `email_campaign` gadget metadata via
   * the workspace door, and upstream delivery history via FavCRM. Sibling rows
   * are metadata only (id/title/status/updatedAt) — the list never claims to
   * hold another gadget's draft.
   */
  async listCampaigns() {
    // The list payload is the bounded summary — reviewState, scheduledFor and
    // a real recipients count or null — never the whole draft blob per row.
    const drafts = this.storage.listCampaigns().map(campaignSummary);
    const siblings = await listWorkspaceGadgets(this.env);
    const history = await favcrmCampaignHistory(this.env, { limit: 50 });
    return {
      ok: true,
      drafts,
      siblings: isDoorRefusal(siblings) ? [] : (Array.isArray(siblings) ? siblings : siblings.data ?? []).filter(
        (row) => row && row.definitionKey === "email_campaign"
      ),
      history: isDoorRefusal(history) ? { refused: history.refused } : { campaigns: history.campaigns ?? history.data ?? [] },
      capabilities: this.getCapabilities().capabilities
    };
  }

  // --- draft reads ----------------------------------------------------------

  getCampaign(id) {
    const campaign = this.storage.getCampaign(id);
    if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
    return { ok: true, campaign };
  }

  /** The selected draft, or the most recent when none is selected. */
  getDraft(input = {}) {
    const id = input.id ?? this.storage.getSession("selectedCampaignId");
    const campaign = id ? this.storage.getCampaign(id) : this.storage.listCampaigns()[0] ?? null;
    if (!campaign) return { ok: false, code: "not_found", message: "No campaign draft yet." };
    const d = campaign.draft;
    return {
      ok: true,
      campaign,
      draft: d,
      previewHtml: sectionsToHtml(d.sections),
      estimateStale: !campaign.estimateKey || campaign.estimateKey !== audienceKey(d),
      missing: missingForSend(d)
    };
  }

  /** The draft as `state_json` fields — what the send bridge mirrors. */
  exportDraft(input = {}) {
    const campaign = input.id ? this.storage.getCampaign(input.id) : null;
    if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
    return {
      ok: true,
      campaignId: campaign.id,
      revision: campaign.revision,
      fingerprint: draftFingerprint(campaign.draft),
      fields: draftToState(campaign.draft)
    };
  }

  /** The rendered HTML the canvas's send-preview shows — typed fields, escaped. */
  previewHtml(input = {}) {
    const campaign = input.id ? this.storage.getCampaign(input.id) : null;
    const draft = campaign ? campaign.draft : normalizeDraft(input.draft ?? {});
    return { ok: true, html: sectionsToHtml(draft.sections) };
  }

  getReview(input = {}) {
    const read = this.getDraft(input);
    if (!read.ok) return read;
    const campaign = read.campaign;
    return {
      ok: true,
      campaign,
      draft: campaign.draft,
      estimate: campaign.estimate,
      estimateStale: read.estimateStale,
      outcome: campaign.outcome,
      savedFingerprint: campaign.savedFingerprint,
      fingerprint: draftFingerprint(campaign.draft),
      missing: read.missing,
      capabilities: this.getCapabilities().capabilities
    };
  }

  // --- draft writes (the command surface) ------------------------------------

  createCampaign(input = {}) {
    return this.enqueueMutation(async () => {
      const draft = normalizeDraft(input.draft ?? {});
      const id = newId("cmp");
      const title = (typeof input.title === "string" && input.title.trim()) || draft.subject || "Untitled campaign";
      const campaign = this.storage.createCampaign({ id, title, draft, now: this.now() });
      this.storage.setSession("selectedCampaignId", id);
      await this.broadcast({ type: "campaign", campaignId: id });
      return { ok: true, campaign };
    });
  }

  /**
   * The declarative command surface, applied to a facet-stored draft. Accepts
   * the definition's command kinds against the same `mutable` allowlist —
   * outcome fields (`review_state`, `favcrm_campaign_id`, `estimate`,
   * `delivery_stats`, `sender_status`, `approvals`) refuse here exactly as
   * they refuse through `state_json`, and the `mutableWhen` lifecycle lock
   * applies on the same `review_state` the outcome mirror carries.
   */
  applyCommand(input = {}) {
    return this.enqueueMutation(async () => this.applyCommandLocked(input));
  }

  async applyCommandLocked({ campaignId, command, expectedRevision }) {
    const id = campaignId ?? this.storage.getSession("selectedCampaignId");
    const campaign = id ? this.storage.getCampaign(id) : null;
    if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
    const applied = applyCommandToDraft(campaign.draft, command, {
      expectedRevision: expectedRevision ?? null,
      revision: campaign.revision,
      reviewState: effectiveReviewState(campaign)
    });
    if (!applied.ok) return applied;
    const saved = this.storage.saveCampaignDraft({
      id: campaign.id,
      draft: applied.draft,
      expectedRevision: expectedRevision ?? null,
      now: this.now()
    });
    if (!saved.ok) return saved;
    // An audience or schedule edit invalidates the last estimate — the review
    // step compares keys rather than trusting a stored number.
    if (this.storage.getSession("selectedCampaignId") !== campaign.id) {
      this.storage.setSession("selectedCampaignId", campaign.id);
    }
    await this.broadcast({ type: "campaign", campaignId: campaign.id, revision: saved.campaign.revision });
    return { ok: true, campaign: saved.campaign, revision: saved.campaign.revision };
  }

  /** Whole-draft save — the composer's "Save draft" button. */
  saveDraft(input = {}) {
    return this.enqueueMutation(async () => {
      const id = input.id ?? this.storage.getSession("selectedCampaignId");
      const campaign = id ? this.storage.getCampaign(id) : null;
      if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
      const reviewState = effectiveReviewState(campaign);
      if (draftLocked(reviewState)) {
        return { ok: false, code: "state_locked", message: `Draft is read-only while review_state is "${reviewState}" — unschedule or undo through the domain to reopen it.` };
      }
      const bad = unsupportedSectionTypes(input.draft?.sections);
      if (bad.length) {
        return { ok: false, code: "unsupported_section", message: `Section type ${bad.map((b) => `"${b}"`).join(", ")} is not supported — sections are ${SECTION_TYPES.join(", ")}. Pasted HTML is refused until the send path can sanitize it.` };
      }
      const draft = normalizeDraft(input.draft ?? {});
      const saved = this.storage.saveCampaignDraft({
        id: campaign.id,
        title: input.title,
        draft,
        expectedRevision: input.expectedRevision ?? null,
        now: this.now()
      });
      if (!saved.ok) return saved;
      await this.broadcast({ type: "campaign", campaignId: campaign.id, revision: saved.campaign.revision });
      return { ok: true, campaign: saved.campaign, revision: saved.campaign.revision };
    });
  }

  selectCampaign(input = {}) {
    const id = typeof input.id === "string" ? input.id : null;
    if (id && !this.storage.getCampaign(id)) return { ok: false, code: "not_found", message: "No such campaign draft." };
    this.storage.setSession("selectedCampaignId", id);
    return { ok: true, selectedCampaignId: id };
  }

  deleteCampaign(input = {}) {
    return this.enqueueMutation(async () => {
      const id = typeof input.id === "string" ? input.id : null;
      if (!id || !this.storage.getCampaign(id)) return { ok: false, code: "not_found", message: "No such campaign draft." };
      this.storage.deleteCampaign(id);
      if (this.storage.getSession("selectedCampaignId") === id) this.storage.setSession("selectedCampaignId", null);
      await this.broadcast({ type: "campaign", campaignId: id, deleted: true });
      return { ok: true };
    });
  }

  // --- proposals -------------------------------------------------------------

  listProposals(input = {}) {
    const campaignId = input.campaignId ?? this.storage.getSession("selectedCampaignId");
    if (!campaignId) return { ok: true, proposals: [] };
    return { ok: true, proposals: this.storage.listProposals(campaignId, input.state ?? null) };
  }

  /**
   * The agent stages a change as a proposal — a batch of draft commands plus a
   * label — instead of writing the draft directly. Accepting applies the batch
   * through the same command path as a direct write, so the lifecycle lock and
   * the section boundary hold for proposals too.
   */
  proposeChange(input = {}) {
    return this.enqueueMutation(async () => {
      const campaignId = input.campaignId ?? this.storage.getSession("selectedCampaignId");
      const campaign = campaignId ? this.storage.getCampaign(campaignId) : null;
      if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
      const id = newId("pp");
      this.storage.createProposal({
        id,
        campaignId: campaign.id,
        kind: typeof input.kind === "string" ? input.kind : "draft",
        payload: input.payload ?? {},
        label: typeof input.label === "string" ? input.label : "",
        baseRevision: campaign.revision,
        now: this.now()
      });
      await this.broadcast({ type: "proposal", campaignId: campaign.id, proposalId: id });
      return { ok: true, proposalId: id };
    });
  }

  /** Accept a staged proposal — applies its command batch to the draft. */
  acceptProposal(input = {}) {
    return this.enqueueMutation(async () => {
      const proposal = this.storage.getProposal(input.id);
      if (!proposal || proposal.state !== "pending") {
        return { ok: false, code: "not_pending", message: "No pending proposal with that id." };
      }
      const commands = Array.isArray(proposal.payload?.commands) ? proposal.payload.commands : [];
      let campaign = this.storage.getCampaign(proposal.campaignId);
      for (const command of commands) {
        const applied = applyCommandToDraft(campaign.draft, command, { expectedRevision: null, revision: campaign.revision, reviewState: effectiveReviewState(campaign) });
        if (!applied.ok) return applied;
        const saved = this.storage.saveCampaignDraft({ id: campaign.id, draft: applied.draft, expectedRevision: null, now: this.now() });
        if (!saved.ok) return saved;
        campaign = saved.campaign;
      }
      this.storage.setProposalState(proposal.id, "accepted");
      await this.broadcast({ type: "campaign", campaignId: campaign.id, revision: campaign.revision });
      return { ok: true, campaign };
    });
  }

  rejectProposal(input = {}) {
    return this.enqueueMutation(async () => {
      const proposal = this.storage.getProposal(input.id);
      if (!proposal || proposal.state !== "pending") {
        return { ok: false, code: "not_pending", message: "No pending proposal with that id." };
      }
      this.storage.setProposalState(proposal.id, "rejected");
      await this.broadcast({ type: "proposal", campaignId: proposal.campaignId, proposalId: proposal.id, rejected: true });
      return { ok: true };
    });
  }

  // --- sender / audience reads (door-mediated) --------------------------------

  async getSenderStatus() {
    const status = await emailSenderStatus(this.env);
    if (isDoorRefusal(status)) return { ok: false, code: status.refused.code, door: status.refused.door, message: status.refused.message };
    return { ok: true, sender: status };
  }

  async listSegments() {
    const result = await favcrmListSegments(this.env);
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    return { ok: true, segments: result.segments ?? result.data ?? [] };
  }

  async searchAccounts(input = {}) {
    const result = await favcrmSearchAccounts(this.env, { query: input.query ?? "", limit: input.limit ?? 25 });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    return { ok: true, accounts: result.accounts ?? result.data ?? [] };
  }

  async getSchedules() {
    const result = await listSchedules(this.env);
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    return { ok: true, schedules: result.schedules ?? result.data ?? [] };
  }

  // --- the governed actions (door-mediated, revision-bound) -------------------

  /**
   * Shared guard for every outbound action: the draft must be saved and
   * sendable, the estimate (when the config requires it) fresh, and the
   * `favcrm_connector` door present. Returns a refusal value on any gap.
   */
  async guardSend(campaign, options = {}) {
    const draft = campaign.draft;
    const missing = missingForSend(draft);
    if (missing.length) {
      return { ok: false, code: "draft_incomplete", missing, message: `The draft is missing ${missing.join(" and ")}.` };
    }
    const config = normalizeConfig(this.storage.getSession("config") ?? {});
    const stale = !campaign.estimateKey || campaign.estimateKey !== audienceKey(draft);
    if (config.requireFreshEstimate && stale && !options.allowStaleEstimate) {
      return { ok: false, code: "estimate_stale", message: "The audience changed since the last estimate — refresh it before sending." };
    }
    const grants = doorGrantStatus(this.env);
    if (grants.favcrm_connector !== true) {
      return { ok: false, code: "capability_unavailable", door: "favcrm_connector", message: "FavCRM is not connected — sending stays blocked until it is." };
    }
    if (grants.email_sender !== true && options.requireSender !== false) {
      return { ok: false, code: "capability_unavailable", door: "email_sender", message: "No verified sender is configured — sending stays blocked until one is." };
    }
    return null;
  }

  /** Refresh the audience estimate through the connector door. */
  async refreshEstimate(input = {}) {
    const read = this.getDraft(input);
    if (!read.ok) return read;
    const result = await favcrmEstimate(this.env, { draft: draftToState(read.campaign.draft) });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    const estimate = result.estimate ?? result.data ?? null;
    this.storage.updateCampaignOutcome(read.campaign.id, {
      estimateJson: estimate ? JSON.stringify(estimate) : null,
      estimateKey: audienceKey(read.campaign.draft),
      now: this.now()
    });
    await this.broadcast({ type: "campaign", campaignId: read.campaign.id });
    return { ok: true, estimate };
  }

  /**
   * `send_test` — the preview's "Send test to yourself". Carries the saved
   * draft through the connector door, which mirrors it into `state_json` and
   * files the governed `send_test` action. `expectedRevision` binds the call
   * to the exact saved draft the owner reviewed.
   */
  async sendTest(input = {}) {
    const read = this.getDraft(input);
    if (!read.ok) return read;
    const campaign = read.campaign;
    const revisionGate = input.expectedRevision !== undefined && input.expectedRevision !== campaign.revision
      ? { ok: false, code: "revision_conflict", message: `Draft moved past revision ${input.expectedRevision} — review the current version.` }
      : null;
    if (revisionGate) return revisionGate;
    const refusal = await this.guardSend(campaign, { allowStaleEstimate: true, requireSender: true });
    if (refusal) return refusal;
    const result = await favcrmSendTest(this.env, {
      campaignId: campaign.id,
      draft: draftToState(campaign.draft),
      to: typeof input.to === "string" ? input.to : "",
      revision: campaign.revision,
      fingerprint: draftFingerprint(campaign.draft)
    });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    this.storage.updateCampaignOutcome(campaign.id, {
      outcomeJson: JSON.stringify({ ...(campaign.outcome ?? {}), lastTest: { at: this.now(), to: input.to ?? "" } }),
      now: this.now()
    });
    await this.broadcast({ type: "campaign", campaignId: campaign.id });
    return { ok: true, result };
  }

  /** `send` — approve-and-send-now. The door files the governed action. */
  async sendNow(input = {}) {
    const read = this.getDraft(input);
    if (!read.ok) return read;
    const campaign = read.campaign;
    if (input.expectedRevision !== undefined && input.expectedRevision !== campaign.revision) {
      return { ok: false, code: "revision_conflict", message: `Draft moved past revision ${input.expectedRevision} — review the current version.` };
    }
    const refusal = await this.guardSend(campaign);
    if (refusal) return refusal;
    const result = await favcrmSendNow(this.env, {
      campaignId: campaign.id,
      draft: draftToState(campaign.draft),
      revision: campaign.revision,
      fingerprint: draftFingerprint(campaign.draft)
    });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    this.storage.updateCampaignOutcome(campaign.id, {
      status: "queued",
      savedFingerprint: draftFingerprint(campaign.draft),
      now: this.now()
    });
    if (this.storage.getSession("notifyOnSendOutcome") !== false) {
      await notifyWorkspace(this.env, { title: "Campaign send queued", body: campaign.title || campaign.draft.subject || "Email campaign" });
    }
    await this.broadcast({ type: "campaign", campaignId: campaign.id });
    return { ok: true, result };
  }

  /** `schedule` — approve-and-send-later, armed through the schedule door. */
  async scheduleSend(input = {}) {
    const read = this.getDraft(input);
    if (!read.ok) return read;
    const campaign = read.campaign;
    if (input.expectedRevision !== undefined && input.expectedRevision !== campaign.revision) {
      return { ok: false, code: "revision_conflict", message: `Draft moved past revision ${input.expectedRevision} — review the current version.` };
    }
    const scheduledFor = typeof input.scheduledFor === "string" ? input.scheduledFor : campaign.draft.scheduled_for;
    if (!scheduledFor) return { ok: false, code: "invalid_argument", message: "A send time is required to schedule." };
    const refusal = await this.guardSend(campaign);
    if (refusal) return refusal;
    const grants = doorGrantStatus(this.env);
    if (grants.schedule !== true) {
      return { ok: false, code: "capability_unavailable", door: "schedule", message: "Scheduling is not granted — sends stay on approval only." };
    }
    const result = await favcrmScheduleSend(this.env, {
      campaignId: campaign.id,
      draft: draftToState({ ...campaign.draft, scheduled_for: scheduledFor }),
      scheduledFor,
      revision: campaign.revision,
      fingerprint: draftFingerprint(campaign.draft)
    });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    this.storage.updateCampaignOutcome(campaign.id, { status: "approved", savedFingerprint: draftFingerprint(campaign.draft), now: this.now() });
    await this.broadcast({ type: "campaign", campaignId: campaign.id });
    return { ok: true, result };
  }

  /** `undo` — cancel a send still inside its undo window. */
  async undoSend(input = {}) {
    const campaignId = input.id ?? this.storage.getSession("selectedCampaignId");
    const campaign = campaignId ? this.storage.getCampaign(campaignId) : null;
    if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
    const result = await favcrmUndoSend(this.env, { campaignId: campaign.id });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    this.storage.updateCampaignOutcome(campaign.id, { status: "draft", now: this.now() });
    await this.broadcast({ type: "campaign", campaignId: campaign.id });
    return { ok: true, result };
  }

  /** Refresh the outcome mirror (review_state, delivery_stats, sender_status). */
  async refreshCampaignStatus(input = {}) {
    const campaignId = input.id ?? this.storage.getSession("selectedCampaignId");
    const campaign = campaignId ? this.storage.getCampaign(campaignId) : null;
    if (!campaign) return { ok: false, code: "not_found", message: "No such campaign draft." };
    const result = await favcrmCampaignStatus(this.env, { campaignId: campaign.id });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    this.storage.updateCampaignOutcome(campaign.id, {
      outcomeJson: JSON.stringify(result.outcome ?? result.data ?? {}),
      status: result.status ?? campaign.status,
      now: this.now()
    });
    await this.broadcast({ type: "campaign", campaignId: campaign.id });
    return { ok: true, campaign: this.storage.getCampaign(campaign.id) };
  }

  /** Sender verification request — files through the email_sender door. */
  async verifySender(input = {}) {
    const result = await emailSenderVerify(this.env, {
      provider: typeof input.provider === "string" ? input.provider : "",
      fromName: typeof input.fromName === "string" ? input.fromName : "",
      fromEmail: typeof input.fromEmail === "string" ? input.fromEmail : ""
    });
    if (isDoorRefusal(result)) return { ok: false, code: result.refused.code, door: result.refused.door, message: result.refused.message };
    await this.broadcast({ type: "capabilities" });
    return { ok: true, result };
  }

  // --- config -----------------------------------------------------------------

  setConfig(input = {}) {
    const issues = configIssues(input);
    if (issues.length) return { ok: false, issues };
    const config = normalizeConfig({ ...(this.storage.getSession("config") ?? {}), ...input });
    this.storage.setSession("config", config);
    if (input.notifyOnSendOutcome !== undefined) this.storage.setSession("notifyOnSendOutcome", config.notifyOnSendOutcome);
    return { ok: true, config };
  }

  // --- subscribers ------------------------------------------------------------

  async subscribe(callback, client = {}) {
    const dup = callback.dup();
    this.subscribers.set(dup, { clientId: String(client?.clientId || "") });
    dup.onRpcBroken(() => {
      this.subscribers.delete(dup);
    });
    return this.summary();
  }

  async broadcast(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.operation(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }
}

/**
 * The campaign's effective `review_state`: the outcome mirror's value when the
 * domain has written one, else the facet's own lifecycle status mapped onto
 * the definition's vocabulary. `queued`/`sent`/`attention` pass through as
 * closed states — everything not in the open set locks the mutable surface,
 * which is the `mutableWhen` contract applied to the facet draft.
 */
function effectiveReviewState(campaign) {
  if (typeof campaign?.outcome?.review_state === "string" && campaign.outcome.review_state) {
    return campaign.outcome.review_state;
  }
  const mapped = { draft: "drafting", in_review: "in_review", approved: "approved" }[campaign?.status];
  return mapped ?? campaign?.status ?? "drafting";
}

function campaignSummary(campaign) {
  return {
    id: campaign.id,
    title: campaign.title,
    status: campaign.status,
    subject: campaign.draft?.subject ?? "",
    revision: campaign.revision,
    updatedAt: campaign.updatedAt,
    // Honest list-row fields: the effective review_state (same computation
    // `applyCommand` locks against), the scheduled time when one exists, and
    // the last estimate's eligible count — a real number or absent, so the
    // canvas shows "—" instead of inventing a recipient count.
    reviewState: effectiveReviewState(campaign),
    scheduledFor: campaign.draft?.scheduled_for ?? "",
    recipients: typeof campaign.estimate?.eligible === "number" ? campaign.estimate.eligible : null
  };
}
