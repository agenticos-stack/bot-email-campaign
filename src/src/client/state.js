// Email Campaign client — the UI state the views render and the loaders that
// fill it from the facet.
//
// `S.campaign` is the facet's saved row; `S.edit` is the composer's working
// copy of `campaign.draft` — the two diverge exactly while the owner has
// unsaved edits, which is what `dirty()` reports and what "approval binds the
// saved revision" depends on. Nothing here invents state: every field traces
// to a facet read (`getDraft`/`getReview`/`getCapabilities`) or a facet write
// (`saveDraft`/`applyCommand`/`sendNow`…).

import { audienceKey, draftFingerprint, missingForSend, normalizeDraft } from "../../model.js";
import { getLocale, setLocale, t } from "./i18n.js";

export const S = {
  view: "auto", // auto | list | editor | setup — auto resolves on first load
  step: 0, // 0 audience · 1 content · 2 review
  filter: "all",
  search: "",
  pane: "canvas", // narrow layout: which half shows
  campaigns: [], // facet draft rows
  siblings: [], // other email_campaign gadgets (metadata only)
  history: [], // upstream FavCRM rows
  capabilities: {}, // { favcrm_connector: {granted, interim}, … }
  sender: null, // { connected, provider, from_email, from_name }
  campaign: null, // the open facet row
  edit: null, // its working draft
  op: null, // { status: 'pending'|'unknown' } — an in-flight/uncertain send
  busy: "",
  readOnly: false,
  loading: true,
  loadError: "",
  customerQuery: "",
  exclusionQuery: "",
  customerResults: [],
  exclusionResults: [],
  segments: [],
  device: "desktop",
  proposals: [],
  conflictChoice: "mine",
  grantKey: "",
  provider: "resend",
  undoTimer: null
};

/** Display status → [en, zh] label, mapped off the facet's lifecycle + op. */
export function statusLabel(campaign) {
  const status = campaign?.status ?? "draft";
  const labels = {
    draft: ["Draft", "草稿"],
    in_review: ["Draft", "草稿"],
    approved: campaign?.draft?.scheduled_for ? ["Scheduled", "已排程"] : ["Approved", "已核准"],
    queued: ["Queued · undo available", "已加入佇列 · 可撤回"],
    sent: ["Sent", "已傳送"],
    attention: ["Needs attention", "需要處理"]
  };
  return labels[status] ?? labels.draft;
}

export function statusClass(campaign) {
  const status = campaign?.status ?? "draft";
  if (S.op?.status === "unknown" || status === "attention") return "attention";
  if (status === "queued") return "buffered";
  if (status === "approved" && campaign?.draft?.scheduled_for) return "scheduled";
  return status === "in_review" ? "draft" : status;
}

export function statusBadge(campaign) {
  return `<span class="status ${statusClass(campaign)}">${t(...statusLabel(campaign))}</span>`;
}

/** Unsaved edits — the working copy diverged from the facet's stored draft. */
export function dirty() {
  return Boolean(S.campaign && S.edit) && draftFingerprint(S.edit) !== draftFingerprint(S.campaign.draft);
}

export function unresolved() {
  return Boolean(S.op && ["pending", "unknown"].includes(S.op.status));
}

/** Editable means: not read-only, not upstream-only, and a lifecycle the owner may still shape. */
export function readOnly() {
  return (
    S.readOnly ||
    S.campaign?.upstreamOnly === true ||
    (S.view === "editor" && !["draft", "in_review", "attention"].includes(S.campaign?.status ?? "draft"))
  );
}

export function busy() {
  return Boolean(S.busy) || S.op?.status === "pending";
}

export function estimateStale() {
  if (!S.campaign || !S.edit) return true;
  return !S.campaign.estimateKey || S.campaign.estimateKey !== audienceKey(S.edit);
}

export function missing() {
  return S.edit ? missingForSend(S.edit) : [];
}

/** The audience summary the list + fingerprint rows show. */
export function sourceLabel(edit) {
  const d = normalizeDraft(edit ?? {});
  if (d.audience_source === "all") return t("All customers", "所有客戶");
  if (d.audience_source === "segment") return d.audience_segment[0]?.label || t("A segment", "客戶群組");
  return t(`${d.audience_accounts.length} selected`, `已選擇 ${d.audience_accounts.length} 位`);
}

// --- loaders ---------------------------------------------------------------

/** Read the capability snapshot — the door strip's source. */
export async function loadCapabilities(rpc) {
  const res = await rpc.getCapabilities();
  if (res?.ok) S.capabilities = res.capabilities ?? {};
  return res;
}

export async function loadSender(rpc) {
  const res = await rpc.getSenderStatus();
  S.sender = res?.ok ? res.sender ?? null : null;
  return res;
}

/** The campaign list: this facet's drafts + sibling metadata + FavCRM history. */
export async function loadCampaigns(rpc) {
  const res = await rpc.listCampaigns();
  if (!res?.ok) {
    S.loadError = res?.message || t("Campaigns could not be loaded", "無法載入活動");
    return res;
  }
  S.loadError = "";
  S.campaigns = res.drafts ?? [];
  S.siblings = (res.siblings ?? []).map((row) => ({ ...row, sibling: true }));
  const hist = res.history;
  S.history = (hist?.campaigns ?? []).map((row) => ({ ...row, upstreamOnly: true }));
  S.capabilities = res.capabilities ?? S.capabilities;
  // First-run resolution: when nothing exists and nothing is granted, land on
  // the capability setup; otherwise land on the list. Resolves once — a later
  // `loadCampaigns` (live event) never re-routes an already-chosen view.
  if (S.view === "auto") {
    const granted = Object.values(S.capabilities).some((c) => c?.granted === true);
    const empty = !S.campaigns.length && !S.siblings.length && !S.history.length;
    S.view = empty && !granted ? "setup" : "list";
  }
  return res;
}

/** Open a draft into the composer — the facet row becomes `S.campaign`, its draft `S.edit`. */
export async function openDraft(rpc, id) {
  const res = await rpc.getDraft({ id });
  if (!res?.ok) return res;
  S.campaign = res.campaign;
  S.edit = normalizeDraft(res.campaign.draft);
  await rpc.selectCampaign({ id: res.campaign.id });
  const props = await rpc.listProposals({ campaignId: res.campaign.id, state: "pending" });
  S.proposals = props?.ok ? props.proposals ?? [] : [];
  S.view = "editor";
  S.step = 0;
  S.op = res.campaign.status === "attention" ? { status: "unknown" } : res.campaign.status === "queued" ? { status: "pending" } : null;
  return res;
}

export function setView(view) {
  S.view = view;
  if (view === "list") {
    S.campaign = null;
    S.edit = null;
    S.op = null;
  }
}
