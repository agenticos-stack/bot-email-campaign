// Email Campaign client — the `data-action` dispatch map.
//
// Every handler is one facet call (or a local edit to `S.edit`, saved on the
// next explicit save). A refused facet call surfaces its message as a toast —
// a capability gap, a stale revision, a missing door — never a silent no-op.
// The map is built once by `createActions({ rpc, render })` so handlers share
// the same rpc and re-render the way every preview handler did.

import { newId, normalizeDraft } from "../../model.js";
import { $, announce, closeDialog } from "./dom.js";
import { getLocale, setLocale, t } from "./i18n.js";
import {
  S,
  dirty,
  estimateStale,
  loadCampaigns,
  loadCapabilities,
  loadSender,
  openDraft,
  setView
} from "./state.js";
import { openConfirm, openConflict, openGrant, openProposal, openScheduleManage, openSender } from "./views.js";

/** Build the dispatch map. `render()` re-renders; `syncDraft()` saves the working copy. */
export function createActions({ rpc, render, requestGrant }) {
  const syncEdit = () => {
    S.edit = normalizeDraft(S.edit ?? {});
  };
  const refreshDraft = async () => {
    if (!S.campaign) return;
    const res = await rpc.getDraft({ id: S.campaign.id });
    if (res?.ok) {
      S.campaign = res.campaign;
      S.edit = normalizeDraft(res.campaign.draft);
      const props = await rpc.listProposals({ campaignId: res.campaign.id, state: "pending" });
      S.proposals = props?.ok ? props.proposals ?? [] : [];
    }
  };
  const refusal = (res) => {
    if (res?.ok === false) announce(res.message || t("That could not be done", "未能完成"));
    return res;
  };

  return {
    locale() {
      setLocale(getLocale() === "zh" ? "en" : "zh");
    },
    enter() {
      setView("list");
    },
    pane(v) {
      S.pane = v;
    },
    async list() {
      setView("list");
      await loadCampaigns(rpc);
    },
    filter(v) {
      S.filter = v;
    },
    async retry() {
      S.loading = true;
      S.loadError = "";
      render();
      await loadCampaigns(rpc);
      S.loading = false;
    },
    async new() {
      const res = await rpc.createCampaign({ draft: {} });
      if (!res?.ok) return refusal(res);
      await openDraft(rpc, res.campaign.id);
    },
    async open(v, el) {
      await openDraft(rpc, v);
    },
    step(v) {
      S.step = +v;
    },
    source(v) {
      if (S.edit) {
        S.edit.audience_source = v;
        S.edit = normalizeDraft(S.edit);
      }
    },
    async estimate() {
      if (!S.campaign) return;
      S.busy = "estimate";
      render();
      const res = await rpc.refreshEstimate({ id: S.campaign.id });
      S.busy = "";
      if (!res?.ok) return refusal(res);
      await refreshDraft();
    },
    async "add-account"(v) {
      if (!S.edit) return;
      const found = S.customerResults.find((c) => (c.account_id ?? c.id) === v);
      if (found) S.edit.audience_accounts = [...S.edit.audience_accounts, { account_id: found.account_id ?? found.id, name: found.name ?? "", email: found.email ?? "" }];
      S.customerQuery = "";
      S.customerResults = [];
    },
    "remove-account"(v) {
      if (S.edit) S.edit.audience_accounts = S.edit.audience_accounts.filter((a) => a.account_id !== v);
    },
    "add-exclusion"(v) {
      if (!S.edit) return;
      const found = S.exclusionResults.find((c) => (c.account_id ?? c.id) === v);
      if (found) S.edit.audience_exclusions = [...S.edit.audience_exclusions, { kind: found.kind ?? "account", id: found.account_id ?? found.id, label: found.name ?? found.label ?? "" }];
      S.exclusionQuery = "";
      S.exclusionResults = [];
    },
    "remove-exclusion"(v) {
      if (S.edit) S.edit.audience_exclusions = S.edit.audience_exclusions.filter((a) => a.id !== v);
    },
    "add-block"(v) {
      if (!S.edit) return;
      S.edit.sections = [...S.edit.sections, { id: newId("s"), type: v, heading: t("New heading", "新標題"), body: "", cta_label: t("Learn more", "了解更多"), cta_url: "https://example.com", image_url: "" }];
    },
    "block-up"(v, el) {
      const id = el.dataset.id;
      const i = S.edit?.sections.findIndex((s) => s.id === id);
      if (i > 0) [S.edit.sections[i - 1], S.edit.sections[i]] = [S.edit.sections[i], S.edit.sections[i - 1]];
    },
    "block-down"(v, el) {
      const id = el.dataset.id;
      const i = S.edit?.sections.findIndex((s) => s.id === id);
      if (i >= 0 && i < S.edit.sections.length - 1) [S.edit.sections[i + 1], S.edit.sections[i]] = [S.edit.sections[i], S.edit.sections[i + 1]];
    },
    "block-del"(v, el) {
      if (S.edit) S.edit.sections = S.edit.sections.filter((s) => s.id !== el.dataset.id);
    },
    device(v) {
      S.device = v;
    },
    async save() {
      if (!S.campaign || !S.edit) return;
      S.busy = "save";
      render();
      const res = await rpc.saveDraft({ id: S.campaign.id, title: S.campaign.title, draft: S.edit, expectedRevision: S.campaign.revision });
      S.busy = "";
      if (res?.ok === false && res.code === "revision_conflict") {
        openConflict();
        return;
      }
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      announce(t("Draft saved", "草稿已儲存"));
    },
    async delete() {
      if (!S.campaign) return;
      const res = await rpc.deleteCampaign({ id: S.campaign.id });
      if (!res?.ok) return refusal(res);
      announce(t("Draft deleted", "草稿已刪除"));
      setView("list");
      await loadCampaigns(rpc);
    },
    proposal() {
      openProposal();
    },
    async "accept-proposal"() {
      const p = S.proposals[0];
      if (!p) return;
      const res = await rpc.acceptProposal({ id: p.id });
      closeDialog();
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      announce(t("Suggestion applied to the draft", "建議已套用至草稿"));
    },
    async "dismiss-proposal"() {
      const p = S.proposals[0];
      if (p) await rpc.rejectProposal({ id: p.id });
      S.proposals = S.proposals.slice(1);
      closeDialog();
    },
    async test() {
      if (!S.campaign) return;
      S.busy = "test";
      render();
      const res = await rpc.sendTest({ id: S.campaign.id, expectedRevision: S.campaign.revision });
      S.busy = "";
      if (!res?.ok) return refusal(res);
      announce(t("Test send filed — check your inbox", "測試傳送已提交——請查看收件匣"));
      await refreshDraft();
    },
    "review-send"() {
      openConfirm();
    },
    async "confirm-send"() {
      closeDialog();
      if (!S.campaign) return;
      const isScheduled = Boolean(S.edit?.scheduled_for);
      S.busy = "send";
      render();
      const res = isScheduled
        ? await rpc.scheduleSend({ id: S.campaign.id, expectedRevision: S.campaign.revision, scheduledFor: S.edit.scheduled_for })
        : await rpc.sendNow({ id: S.campaign.id, expectedRevision: S.campaign.revision });
      S.busy = "";
      if (res?.ok === false && res.code === "revision_conflict") {
        openConflict();
        return;
      }
      if (res?.ok === false && res.result?.status === "unknown") {
        S.op = { status: "unknown" };
        announce(t("Send status is uncertain — held for reconciliation", "傳送狀態未明——暫停以待對帳"));
        render();
        return;
      }
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      announce(isScheduled ? t("Approved — scheduled", "已核准——已排程") : t("Approved — queued. Undo is open for a few seconds.", "已核准——已加入佇列。數秒內仍可撤回。"));
      if (!isScheduled) {
        clearTimeout(S.undoTimer);
        S.undoTimer = setTimeout(async () => {
          await refreshDraft();
          render();
        }, 8000);
      }
    },
    async undo() {
      if (!S.campaign) return;
      const res = await rpc.undoSend({ id: S.campaign.id });
      if (!res?.ok) return refusal(res);
      clearTimeout(S.undoTimer);
      S.op = null;
      await refreshDraft();
      announce(t("Send undone — back to draft", "已撤回傳送——回復為草稿"));
    },
    async recheck() {
      if (!S.campaign) return;
      const res = await rpc.refreshCampaignStatus({ id: S.campaign.id });
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      if (S.campaign?.status === "attention") announce(t("Still unknown — the receipt has not arrived", "仍未確定——尚未收到回執"));
      else announce(t("Receipt found — status reconciled", "已找到回執——狀態已對帳"));
    },
    schedule() {
      openScheduleManage();
    },
    async reschedule() {
      const v = $("#reschedule")?.value;
      if (v && S.campaign) {
        const res = await rpc.scheduleSend({ id: S.campaign.id, expectedRevision: S.campaign.revision, scheduledFor: v });
        closeDialog();
        if (!res?.ok) return refusal(res);
        await refreshDraft();
        announce(t("Rescheduled — re-approved for the new time", "已更改——已就新時間重新核准"));
      }
    },
    async unschedule() {
      if (!S.campaign) return;
      // Unscheduling edits the draft back to "send on approval" and drops the
      // approved status — a draft edit through the command surface.
      const res = await rpc.applyCommand({ campaignId: S.campaign.id, command: { kind: "state.set", path: "scheduled_for", value: "" }, expectedRevision: S.campaign.revision });
      closeDialog();
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      announce(t("Unscheduled — the draft is editable again", "已取消排程——可再次編輯草稿"));
    },
    "grant-favcrm"() {
      requestGrant("favcrm_connector");
      openGrant("favcrm_connector");
    },
    "grant-schedule"() {
      requestGrant("schedule");
      openGrant("schedule");
    },
    "grant-workspace"() {
      requestGrant("workspace");
      openGrant("workspace");
    },
    async grant() {
      // The grant itself is the host's — the dialog is the bot's ask. On the
      // platform the door appears on the next refresh; the interim doors may
      // still resolve to nothing, which `getCapabilities` reports honestly.
      const res = await rpc.refreshGrants();
      if (res?.ok) S.capabilities = res.capabilities ?? S.capabilities;
      closeDialog();
      announce(capGranted(S.grantKey) ? t("Granted", "已授予") : t("Requested — this capability may not be available yet", "已提出請求——此功能可能尚未提供"));
    },
    deny() {
      closeDialog();
      announce(t("Not granted — the bot keeps working without it", "未授予——機械人可在缺少此功能下繼續運作"));
    },
    sender() {
      openSender();
    },
    async "connect-sender"() {
      const f = $("#sender-from")?.value;
      const n = $("#sender-name")?.value;
      S.busy = "sender";
      render();
      const res = await rpc.verifySender({ provider: S.provider, fromName: n ?? "", fromEmail: f ?? "" });
      S.busy = "";
      if (!res?.ok) {
        closeDialog();
        return refusal(res);
      }
      await loadSender(rpc);
      await loadCapabilities(rpc);
      closeDialog();
      announce(t("Sender verified", "寄件者已驗證"));
    },
    async "resolve-conflict"() {
      if (!S.campaign) return;
      if (S.conflictChoice === "theirs") {
        // Take the facet's saved draft — discard the working copy.
        S.edit = normalizeDraft(S.campaign.draft);
        closeDialog();
        announce(t("Loaded the saved revision", "已載入已儲存版本"));
        return;
      }
      // Keep mine: save the working copy at the current revision.
      const res = await rpc.saveDraft({ id: S.campaign.id, title: S.campaign.title, draft: S.edit, expectedRevision: S.campaign.revision });
      closeDialog();
      if (!res?.ok) return refusal(res);
      await refreshDraft();
      announce(t("Conflict resolved — your text saved", "衝突已解決——已儲存您的內容"));
    },
    "close-dialog"() {
      closeDialog();
    }
  };
}

function capGranted(key) {
  return S.capabilities?.[key]?.granted === true;
}
