// Email Campaign client — the UI state the views render and the loaders that
// fill it from the facet.
//
// `S.campaign` is the facet's saved row; `S.edit` is the composer's working
// copy of `campaign.draft` — the two diverge exactly while the owner has
// unsaved edits, which is what `dirty()` reports and what "approval binds the
// saved revision" depends on. Nothing here invents state: every field traces
// to a facet read (`getDraft`/`getReview`/`getCapabilities`) or a facet write
// (`saveDraft`/`applyCommand`/`sendNow`…).

import { EMAIL_CAMPAIGN_DEFINITION } from "../../../definition.ts";
import { audienceKey, draftFingerprint, missingForSend, normalizeDraft } from "../../model.js";
import { getLocale, number, setLocale, t } from "./i18n.js";

export const S = {
  view: "auto", // auto | list | new | editor | setup — auto resolves on first load
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
  newName: "",
  testTo: "",
  testSent: "",
  menuOpen: false,
  undoTimer: null
};

// ---------------------------------------------------------------------------
// review_state — the definition's vocabulary, projected into the canvas.
//
// The list's filter tabs and status chips read the SAME `review_state` options
// the definition declares, so adding or removing an option changes the tabs
// with no second list to edit. `mutableWhen.in` names the open (editable)
// states; they fold into the one "Draft" tab the accepted design shows —
// every closed option gets its own tab.
// ---------------------------------------------------------------------------

export const REVIEW_STATE_OPTIONS = Object.freeze(
  EMAIL_CAMPAIGN_DEFINITION.fields.find((field) => field.key === "review_state")?.options ?? []
);
const OPEN_STATE_OPTIONS = Object.freeze(REVIEW_STATE_OPTIONS.filter((option) => EMAIL_CAMPAIGN_DEFINITION.mutableWhen?.in?.includes(option)));

/** Display vocabulary for a review_state option — [en, zh] label + chip tone. */
const STATE_VOCAB = {
  drafting: { label: ["Draft", "草稿"], tone: "neutral" },
  in_review: { label: ["In review", "審閱中"], tone: "neutral" },
  approved: { label: ["Approved", "已核准"], tone: "neutral" },
  scheduled: { label: ["Scheduled", "已排程"], tone: "warning" },
  sending: { label: ["Sending", "傳送中"], tone: "warning" },
  sent: { label: ["Sent", "已發送"], tone: "success" },
  paused: { label: ["Paused", "已暫停"], tone: "warning" },
  cancelled: { label: ["Cancelled", "已取消"], tone: "neutral" }
};

/**
 * A row's effective review_state: the domain mirror's value when it wrote one,
 * else the facet lifecycle mapped onto the definition's vocabulary — the same
 * mapping `effectiveReviewState` applies server-side. `approved` carrying a
 * `scheduled_for` IS the scheduled state the domain writes; facet-only
 * statuses past approval (`queued`, `attention`) group under `sent` for
 * filtering while keeping their honest chip labels.
 */
export function reviewStateOf(campaign) {
  // The facet computes the honest value — prefer it (list rows carry it).
  if (typeof campaign?.reviewState === "string" && campaign.reviewState) return campaign.reviewState;
  const mirror = campaign?.outcome?.review_state;
  if (typeof mirror === "string" && mirror) return mirror;
  const status = campaign?.status ?? "draft";
  if (status === "approved") return campaign?.draft?.scheduled_for ? "scheduled" : "approved";
  return { draft: "drafting", in_review: "in_review", sent: "sent", queued: "sent", attention: "sent" }[status] ?? status;
}

/** The row's Recipients cell — a real count or an honest dash, never invented. */
export function recipientsOf(row) {
  if (typeof row?.recipients === "number") return number(row.recipients);
  if (typeof row?.estimate?.eligible === "number") return number(row.estimate.eligible);
  if (typeof row?.stats?.sent === "number") return number(row.stats.sent);
  return "—";
}

/**
 * The list's filter tabs, projected from `review_state` options. The first is
 * always All; options inside the definition's mutable set share the Draft
 * tab; every closed option is its own tab. `[en, zh]` labels come from
 * STATE_VOCAB, falling back to the raw option so a new option still renders.
 */
export function filterTabs(options = REVIEW_STATE_OPTIONS, open = OPEN_STATE_OPTIONS) {
  const tabs = [{ id: "all", states: null, label: ["All", "全部"] }];
  const openStates = options.filter((option) => open.includes(option));
  if (openStates.length) tabs.push({ id: "draft", states: openStates, label: ["Drafts", "草稿"] });
  for (const option of options.filter((entry) => !open.includes(entry))) {
    const vocab = STATE_VOCAB[option];
    tabs.push({ id: option, states: [option], label: vocab?.label ?? [option.replace(/_/g, " "), option] });
  }
  return tabs;
}

/** The status chip — label + badge tone — for a list row or the editor head. */
export function statusChip(campaign) {
  const status = campaign?.status ?? "draft";
  if (S.op?.status === "unknown" || status === "attention") return { label: ["Needs attention", "需要處理"], tone: "danger" };
  if (status === "queued") return { label: ["Queued — undo open", "已加入佇列 · 可撤回"], tone: "warning" };
  const state = reviewStateOf(campaign);
  const vocab = STATE_VOCAB[state];
  return { label: vocab?.label ?? [state.replace(/_/g, " "), state], tone: vocab?.tone ?? "neutral" };
}

/** Row "updated" column — minute precision, today gets a bare time. */
export function when(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "—";
  const now = new Date();
  const hm = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  if (dt.toDateString() === now.toDateString()) return t(`Today ${hm}`, `今天 ${hm}`);
  const md = getLocale() === "zh" ? `${dt.getMonth() + 1} 月 ${dt.getDate()} 日` : `${dt.getMonth() + 1}/${dt.getDate()}`;
  return `${md} ${hm}`;
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
  let res;
  try {
    res = await rpc.listCampaigns();
  } catch (error) {
    // A thrown refusal (the local-runtime bridge throws on ok:false) still
    // carries the facet's reason in error.message — show it, not a paraphrase.
    S.loadError = error?.message || t("Campaigns could not be loaded", "無法載入活動");
    return { ok: false };
  }
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
  S.testSent = "";
  S.menuOpen = false;
  S.op = res.campaign.status === "attention" ? { status: "unknown" } : res.campaign.status === "queued" ? { status: "pending" } : null;
  return res;
}

export function setView(view) {
  S.view = view;
  S.menuOpen = false;
  if (view === "list") {
    S.campaign = null;
    S.edit = null;
    S.op = null;
  }
}
