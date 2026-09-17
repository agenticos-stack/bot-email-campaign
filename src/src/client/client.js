// Email Campaign client — the sandboxed canvas's entry point.
//
// Mounts the gadget's UI into `#gadget-root` (the canvas the host's sandbox
// document provides), injects the stylesheet, and wires the three surfaces a
// gadget owns: the `globalThis.gadget` RPC to the facet, the `data-action` /
// `data-field` dispatch the views render, and the `gadget:grant-door` /
// `gadget:grant-result` / `gadget:doors-changed` postMessage consent protocol
// with the host (grant-request.js is that contract's shared half).

import sharedTokens from "@agenticos-dev/bot-shell/tokens.css";
import sharedComponents from "@agenticos-dev/bot-shell/components.css";
import appCss from "./app.css";

import {
  canvasGrantPersistToAgent,
  newGrantRequestId,
  parseGadgetDoorsChangedMessage,
  parseGadgetGrantResultMessage
} from "../../grant-request.js";
import { normalizeDraft } from "../../model.js";
import { createActions } from "./actions.js";
import { $, preserveRender } from "@agenticos-dev/bot-shell/client/dom.js";
import { closeDialog } from "@agenticos-dev/bot-shell/client/drawer.js";
import { announce } from "@agenticos-dev/bot-shell/client/toast.js";
import { getLocale, setLocale, t } from "./i18n.js";
import { createRpc } from "@agenticos-dev/bot-shell/client/rpc.js";
import { S, loadCampaigns, loadCapabilities, loadSender, openDraft, setView } from "./state.js";
import { gadgetApp } from "./views.js";

// The facet's method surface — createRpc wraps only what is declared here, so
// a contract change on the server side touches this list rather than every
// view module that happens to need a row.
const RPC_METHODS = [
  "summary", "getCapabilities", "refreshGrants", "setConfig",
  "listCampaigns", "getCampaign", "getDraft", "getReview", "exportDraft", "previewHtml",
  "createCampaign", "applyCommand", "saveDraft", "selectCampaign", "deleteCampaign",
  "listProposals", "proposeChange", "acceptProposal", "rejectProposal",
  "getSenderStatus", "listSegments", "searchAccounts", "getSchedules",
  "refreshEstimate", "sendTest", "sendNow", "scheduleSend", "undoSend", "refreshCampaignStatus", "verifySender",
  "subscribe"
];

const BASE_STYLE = `${sharedTokens}\n${sharedComponents}\n${appCss}`;

function buildChrome() {
  const style = document.createElement("style");
  style.textContent = BASE_STYLE;
  document.head.appendChild(style);
  // The sandbox body ships only #gadget-root — the dialog + toast the views
  // address by id are this canvas's own chrome, appended beside it.
  if (!$("#dialog")) {
    const dlg = document.createElement("dialog");
    dlg.id = "dialog";
    dlg.setAttribute("closedby", "any");
    dlg.setAttribute("aria-labelledby", "dialog-title");
    document.body.appendChild(dlg);
  }
  if (!$("#toast")) {
    const toast = document.createElement("div");
    toast.id = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }
}

function App() {
  const root = document.getElementById("gadget-root") ?? document.body;
  // The workspace shell passes `?locale=`; `?lang=` stays for direct links.
  const qs = new URLSearchParams(location.search);
  setLocale((qs.get("locale") ?? qs.get("lang")) === "zh-HK" ? "zh" : "en");
  buildChrome();
  const rpc = createRpc(globalThis.gadget, RPC_METHODS);

  function render() {
    document.documentElement.lang = getLocale() === "zh" ? "zh-HK" : "en";
    preserveRender(root, gadgetApp());
  }

  // --- grant postMessages ---------------------------------------------------
  // `requestGrant` posts the ask; the host answers with a correlated
  // `gadget:grant-result`, or with an unprompted `gadget:doors-changed` when a
  // grant happened elsewhere. Both re-read capabilities rather than trusting
  // the message — the message is a prompt to check, not the check's answer.
  const pendingGrants = new Map();
  function requestGrant(requirementKey) {
    const requestId = newGrantRequestId();
    pendingGrants.set(requestId, requirementKey);
    try {
      window.parent?.postMessage(
        { type: "gadget:grant-door", requirementKey, requestId, persistToAssistant: canvasGrantPersistToAgent($("#grant-persist")?.checked) },
        "*"
      );
    } catch {}
  }

  window.addEventListener("message", async (event) => {
    const result = parseGadgetGrantResultMessage(event.data);
    if (result) {
      const key = result.requirementKey;
      if (result.outcome === "activated") {
        await refreshCapabilities();
        announce(t("Granted", "已授予"));
      } else if (result.outcome === "denied" || result.outcome === "cancelled") {
        announce(t("Not granted — the bot keeps working without it", "未授予——機械人可在缺少此功能下繼續運作"));
      } else {
        announce(t("The request did not complete — check the connection", "請求未完成——請檢查連接"));
      }
      pendingGrants.delete(result.requestId);
      render();
      return;
    }
    const changed = parseGadgetDoorsChangedMessage(event.data);
    if (changed) {
      await refreshCapabilities();
      render();
    }
  });

  async function refreshCapabilities() {
    await loadCapabilities(rpc);
    await loadSender(rpc);
  }

  const act = createActions({ rpc, render, requestGrant });

  // --- events ---------------------------------------------------------------
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const fn = act[el.dataset.action];
    if (!fn) return;
    if (el.getAttribute("aria-disabled") === "true") return;
    if (el.dataset.action !== "menu") S.menuOpen = false;
    Promise.resolve(fn(el.dataset.value ?? el.dataset.id, el))
      .catch((error) => console.error(error))
      .then(render);
  });

  let searchTimer = null;
  document.addEventListener("input", (e) => {
    if (e.isComposing) return;
    const el = e.target.closest("[data-field]");
    if (el) {
      const k = el.dataset.field;
      if (k === "list-search") {
        S.search = el.value;
        render();
        return;
      }
      if (k === "customerQuery") {
        S.customerQuery = el.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const res = await rpc.searchAccounts({ query: S.customerQuery, limit: 25 });
          S.customerResults = res?.ok ? res.accounts ?? [] : [];
          render();
        }, 200);
        return;
      }
      if (k === "exclusionQuery") {
        S.exclusionQuery = el.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(async () => {
          const res = await rpc.searchAccounts({ query: S.exclusionQuery, limit: 25 });
          const accounts = res?.ok ? res.accounts ?? [] : [];
          const campaigns = S.campaigns.filter((c) => (c.title || "").toLowerCase().includes(S.exclusionQuery.toLowerCase())).map((c) => ({ id: c.id, kind: "campaign", label: c.title }));
          S.exclusionResults = [...accounts, ...campaigns];
          render();
        }, 200);
        return;
      }
      if (k === "audience_source") {
        if (S.edit) {
          S.edit.audience_source = el.value;
          S.edit = normalizeDraft(S.edit);
        }
        render();
        return;
      }
      if (k === "segment") {
        if (S.edit) {
          const seg = S.segments.find((s) => (s.segment_id ?? s.id) === el.value);
          S.edit.audience_segment = seg ? [{ segment_id: seg.segment_id ?? seg.id, label: seg.label ?? seg.name ?? "" }] : [{ segment_id: el.value, label: el.value }];
        }
        render();
        return;
      }
      if (k === "timing") {
        if (S.edit) S.edit.scheduled_for = el.value === "later" ? S.edit.scheduled_for || "" : "";
        render();
        return;
      }
      if (k === "schedule") {
        if (S.edit) S.edit.scheduled_for = el.value;
        render();
        return;
      }
      if (k === "newName") {
        S.newName = el.value;
        render();
        return;
      }
      if (k === "testTo") {
        S.testTo = el.value;
        render();
        return;
      }
      if (k === "conflictChoice") {
        S.conflictChoice = el.value;
        return;
      }
      if (k === "provider") {
        S.provider = el.value;
        return;
      }
      if (S.edit && ["title", "subject", "preheader"].includes(k)) {
        if (k === "title") {
          if (S.campaign) S.campaign.title = el.value;
        } else S.edit[k] = el.value;
        render();
        return;
      }
    }
    const blk = e.target.closest("[data-block]");
    if (blk && S.edit) {
      const s = S.edit.sections.find((x) => x.id === blk.dataset.block);
      if (s) {
        s[blk.dataset.bf] = blk.value;
        render();
      }
    }
  });

  // Radios, selects and datetime inputs commit on `change`, not `input` —
  // route the same fields through a second listener (the input handler's
  // switch covers the shared cases; setting is idempotent).
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-field]");
    if (!el) return;
    const k = el.dataset.field;
    if (k === "audience_source" && S.edit) {
      S.edit.audience_source = el.value;
      S.edit = normalizeDraft(S.edit);
      render();
    } else if (k === "timing" && S.edit) {
      S.edit.scheduled_for = el.value === "later" ? S.edit.scheduled_for || "" : "";
      render();
    } else if (k === "schedule" && S.edit) {
      S.edit.scheduled_for = el.value;
      render();
    } else if (k === "segment" && S.edit) {
      const seg = S.segments.find((s) => (s.segment_id ?? s.id) === el.value);
      S.edit.audience_segment = seg ? [{ segment_id: seg.segment_id ?? seg.id, label: seg.label ?? seg.name ?? "" }] : [{ segment_id: el.value, label: el.value }];
      render();
    } else if (k === "conflictChoice") {
      S.conflictChoice = el.value;
    } else if (k === "provider") {
      S.provider = el.value;
    }
  });

  document.addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#dialog")?.open) closeDialog();
  });

  // --- live updates ---------------------------------------------------------
  class GadgetSubscriber extends RpcTarget {
    operation(event) {
      handleOperation(event).catch((error) => console.error(error));
    }
    presence() {}
  }
  const liveClientId = Math.random().toString(36).slice(2);
  let liveSubscribed = false;
  async function establishLiveUpdates() {
    await rpc.subscribe(new GadgetSubscriber(), { clientId: liveClientId });
    if (liveSubscribed) await handleOperation({ type: "reconnected" });
    liveSubscribed = true;
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("online", () => {
      if (liveSubscribed) establishLiveUpdates().catch((error) => console.error(error));
    });
  }

  async function handleOperation(event) {
    if (["campaign", "proposal", "capabilities", "reconnected"].includes(event?.type)) {
      try {
        if (S.view === "editor" && S.campaign) {
          const res = await rpc.getDraft({ id: S.campaign.id });
          if (res?.ok) {
            const editing = S.edit && JSON.stringify(S.edit) !== JSON.stringify(res.campaign.draft);
            S.campaign = res.campaign;
            if (!editing) S.edit = res.campaign.draft;
          }
          const props = await rpc.listProposals({ campaignId: S.campaign.id, state: "pending" });
          S.proposals = props?.ok ? props.proposals ?? [] : [];
        } else {
          await loadCampaigns(rpc);
        }
        await refreshCapabilities();
        render();
      } catch (error) {
        console.error(error);
      }
    }
  }

  // --- init -------------------------------------------------------------------
  (async function init() {
    try {
      // Each loader stores a refusal's message in its own state field; the
      // views render what the facet said. Boot must not console.error an
      // expected refusal — a refused read is a fact about capability, not a
      // code defect.
      await loadCapabilities(rpc);
      await loadSender(rpc);
      if (capOkAny("favcrm_connector")) {
        const seg = await rpc.listSegments().catch(() => null);
        if (seg?.ok) S.segments = seg.segments ?? [];
      }
      await loadCampaigns(rpc);
      await establishLiveUpdates();
    } catch (error) {
      // Only an unexpected failure reaches here — still shown, still real.
      S.loadError = error?.message || t("Campaigns could not be loaded", "無法載入活動");
    }
    S.loading = false;
    render();
  })();

  function capOkAny(key) {
    return S.capabilities?.[key]?.granted === true;
  }
}

if (typeof document !== "undefined") App();
