// Email Campaign client — the views the accepted preview defines, rendered
// off `S` (state.js) and the facet's draft model.
//
// Every function returns an HTML string; every untrusted value passes through
// `esc()` at the render site. There is no raw-HTML escape hatch: the four
// section types are the whole content model, and pasted markup is refused at
// the draft boundary until the send path can carry it.

import { audienceKey, normalizeDraft } from "../../model.js";
import { $, announce, button, closeDialog, dialogShell, esc, field, icon, notice } from "./dom.js";
import { formatSchedule, number, t } from "./i18n.js";
import {
  S,
  busy,
  dirty,
  estimateStale,
  missing,
  readOnly,
  sourceLabel,
  statusBadge,
  unresolved
} from "./state.js";

// ---------------------------------------------------------------- helpers

const cap = (key) => S.capabilities?.[key] ?? { granted: false, interim: false };
const capOk = (key) => cap(key).granted === true;

/** Section type → [en, zh] + icon, for the block header and the add-block row. */
const SECTION_META = {
  heading: ["Heading", "標題", "heading"],
  body: ["Body", "內文", "text"],
  cta: ["Button", "按鈕", "link"],
  image: ["Image", "圖片", "image"]
};

function results(query, kind, locked) {
  if (locked || !query || query.length < 1) return "";
  const inList = kind === "account" ? S.edit?.audience_accounts ?? [] : S.edit?.audience_exclusions ?? [];
  const found = (kind === "account" ? S.customerResults : S.exclusionResults).filter(
    (c) => !inList.some((a) => (a.account_id ?? a.id) === (c.account_id ?? c.id))
  );
  if (!found.length) return "";
  return `<div class="results" aria-label="${t("Matching records", "符合條件的記錄")}">${found
    .map(
      (c) =>
        `<button class="result" data-action="add-${kind}" data-id="${esc(c.account_id ?? c.id)}" data-key="res-${kind}-${esc(c.account_id ?? c.id)}"><span class="grow"><strong>${esc(c.name ?? c.label)}</strong><span class="faint">${esc(c.email ?? c.kind ?? "")}</span></span>${icon("plus")}</button>`
    )
    .join("")}</div>`;
}

function chips(items, kind) {
  if (!items?.length) return "";
  return `<div class="chip-list">${items
    .map(
      (c) =>
        `<span class="chip">${esc(c.name ?? c.label)}${
          !readOnly()
            ? `<button data-action="remove-${kind}" data-id="${esc(c.account_id ?? c.id)}" data-key="remove-${kind}-${esc(c.account_id ?? c.id)}" aria-label="${t("Remove", "移除")} ${esc(c.name ?? c.label)}">${icon("close")}</button>`
            : ""
        }</span>`
    )
    .join("")}</div>`;
}

// ------------------------------------------------------------------- shell

/** The capability strip — each declared door's grant state, honestly. */
function doorStrip() {
  const sender = S.sender;
  const pill = (key, ic, okLabel, gapLabel, action, actLabel) => {
    const c = cap(key);
    const label = c.granted ? okLabel : gapLabel;
    return `<span class="door-pill ${c.granted ? "ok" : "gap"}" ${c.interim && !c.granted ? `title="${t("Not available on this platform yet", "此平台尚未提供")}"` : ""}>${icon(ic)}<span>${label}</span>${c.granted ? "" : button(action, actLabel, { kind: "quiet", key: "door-" + action })}</span>`;
  };
  return `<div class="door-strip" aria-label="${t("Granted capabilities", "已授權的功能")}">
    ${pill("favcrm_connector", "users", t("FavCRM · audience & delivery", "FavCRM · 對象及傳送"), t("FavCRM not connected", "尚未連接 FavCRM"), "grant-favcrm", t("Connect", "連接"))}
    ${pill("email_sender", "mail", t("Sender", "寄件者") + (sender?.from_email ? ` · ${esc(sender.from_email)}` : ""), t("No sender verified", "尚未驗證寄件者"), "sender", t("Set up", "設定"))}
    ${pill("schedule", "clock", t("Scheduling", "排程"), t("Scheduling off", "排程未啟用"), "grant-schedule", t("Allow", "允許"))}
    ${pill("workspace", "bell", t("Workspace notices", "工作區通知"), t("Notifications off", "通知已關閉"), "grant-workspace", t("Allow", "允許"))}
  </div>`;
}

export function gadgetApp() {
  if (S.loading) return `<div class="gadget"><div class="list">${'<div class="skel"></div>'.repeat(4)}</div></div>`;
  if (S.view === "editor" && S.campaign) return editorView();
  if (S.view === "setup") return setupView();
  return listView();
}

function setupView() {
  const row = (key, ic, title, body, action, label) =>
    `<div class="setup-row"><span class="setup-ic">${icon(ic)}</span><div class="grow"><h3>${title}</h3><p>${body}</p></div>${capOk(key) ? `<span class="status ready">${t("Granted", "已授權")}</span>` : button(action, label, { kind: "quiet", key: "setup-" + action })}</div>`;
  return `<div class="gadget"><div class="setup"><div class="titleline"><h1>${t("Set up Email Campaigns", "設定電郵活動")}</h1><p>${t("These capabilities connect this bot to your workspace. You can grant them now or later — drafting works either way; only sending waits on them.", "連接這些功能即可使用此機械人。您可以現在或稍後授權——草擬不受影響，只有傳送需要授權。")}</p></div>
  <section class="setup-card"><h2>${t("Capabilities", "功能授權")}</h2><p>${t("Each opens the platform grant dialog — the bot asks, you decide. Nothing here is granted silently.", "每項均會開啟平台授權對話框——機械人只能提出請求，由您決定。系統不會靜默授權。")}</p>
    ${row("favcrm_connector", "users", t("Customer CRM", "客戶 CRM"), t("Reads segments and customers, and hands delivery to FavCRM's queue — consent and unsubscribe stay with it.", "讀取客戶群組及客戶資料，並交由 FavCRM 佇列傳送——同意狀態及取消訂閱均由其管理。"), "grant-favcrm", t("Connect FavCRM", "連接 FavCRM"))}
    ${row("email_sender", "mail", t("Sender identity", "寄件者身分"), t("The verified address campaigns are sent from, via your email provider.", "活動使用的已驗證寄件地址，經您的電郵服務商發出。"), "sender", t("Set up sender", "設定寄件者"))}
    ${row("workspace", "bell", t("Workspace notifications", "工作區通知"), t("Tells you when a send finishes, fails, or needs a decision. Optional.", "傳送完成、失敗或需要您決定時通知您。可選。"), "grant-workspace", t("Allow notifications", "允許通知"))}
  </section>
  ${button("enter", t("Open the bot", "開啟機械人"), { kind: "primary", key: "enter" })}
  </div></div>`;
}

// --------------------------------------------------------------- list view

function listView() {
  const drafts = S.campaigns.map((c) => ({ ...c, kind: "draft" }));
  const siblings = S.siblings.map((s) => ({ id: s.id, title: s.title ?? s.label ?? s.id, draft: { subject: s.subject ?? "" }, status: "draft", updatedAt: s.updatedAt ?? "", kind: "sibling", upstreamOnly: false }));
  const upstream = S.history.map((h) => ({ id: h.id ?? h.campaign_id, title: h.title ?? h.name ?? h.subject ?? "Campaign", draft: { subject: h.subject ?? "" }, status: "sent", updatedAt: h.updatedAt ?? h.sent_at ?? "", kind: "history", upstreamOnly: true, stats: h.stats ?? null }));
  const list = [...drafts, ...siblings, ...upstream];
  const filtered = list.filter(
    (d) => (S.filter === "all" || (d.status === S.filter || (S.filter === "draft" && d.status === "in_review"))) &&
      `${d.title} ${d.draft?.subject ?? ""}`.toLowerCase().includes(S.search.toLowerCase())
  );
  const filters = [["all", "All", "全部"], ["draft", "Drafts", "草稿"], ["approved", "Approved", "已核准"], ["sent", "Sent", "已傳送"]];
  let body = "";
  if (S.loadError) body = notice(t("Campaigns could not be loaded", "無法載入活動"), t("The gadget store did not answer. Your drafts are unchanged.", "小工具儲存未回應，草稿不受影響。"), "error", button("retry", t("Try again", "重試"), { key: "retry" }));
  else if (!filtered.length) body = `<div class="empty"><h2>${t("No campaigns yet", "尚未有活動")}</h2><p>${t("Ask the assistant for a first draft, or start one yourself. Approving a send is always yours.", "請助理草擬首個活動，或自行建立。傳送核准永遠由您決定。")}</p>${button("new", t("New campaign", "建立活動"), { kind: "primary", ic: "plus", disabled: S.readOnly })}</div>`;
  else
    body = `<div class="list">${filtered
      .map(
        (d) => `<button class="campaign" data-action="open" data-id="${esc(d.id)}" data-kind="${d.kind}" data-key="open-${esc(d.id)}">
      <span class="grow"><span class="name">${esc(d.title || t("Untitled campaign", "未命名活動"))}</span><span class="sub">${esc(d.draft?.subject ?? "")}</span></span>
      <span class="audience">${d.kind === "draft" ? sourceLabel(d.draft) : t("Upstream", "上游")}</span>
      <span class="when">${d.stats ? `${number(d.stats.sent)} ${t("sent", "已傳送")}` : esc(d.updatedAt ?? "")}</span>
      ${statusBadge(d)}</button>`
      )
      .join("")}</div>`;
  return `<div class="gadget"><div class="titleline"><h1>${t("Email campaigns", "電郵活動")}</h1><p>${t("The bot drafts, your CRM owns consent and delivery, you approve every send.", "機械人草擬內容，CRM 管理同意及傳送，每次傳送均由您核准。")}</p></div>
  ${doorStrip()}
  ${S.readOnly ? notice(t("You have view access", "您擁有檢視權限"), t("You can inspect campaigns. Editing and sending require additional access.", "您可以檢視活動；編輯及傳送需要額外權限。")) : ""}
  ${!capOk("favcrm_connector") ? notice(t("Connect FavCRM to unlock audiences and delivery", "連接 FavCRM 以使用收件對象及傳送"), t("Drafting works without it. The bot will not invent a recipient list.", "未連接時仍可草擬，機械人不會虛構收件名單。"), "warn", button("grant-favcrm", t("Connect FavCRM", "連接 FavCRM"), { key: "notice-favcrm" })) : ""}
  <div class="toolbar"><div class="filter-tabs" aria-label="${t("Filter campaigns", "篩選活動")}">${filters
    .map(([f, en, zh]) => `<button class="filter-tab ${S.filter === f ? "active" : ""}" data-action="filter" data-value="${f}" data-key="filter-${f}" aria-pressed="${S.filter === f}">${t(en, zh)}<span>${f === "all" ? list.length : list.filter((d) => d.status === f).length}</span></button>`)
    .join("")}</div><div class="flex"><div class="search">${icon("search")}<input type="search" id="list-search" data-field="list-search" data-key="list-search" value="${esc(S.search)}" placeholder="${t("Search campaigns", "搜尋活動")}" aria-label="${t("Search campaigns", "搜尋活動")}"></div>${button("new", t("New campaign", "建立活動"), { kind: "primary", ic: "plus", disabled: S.readOnly, key: "new" })}</div></div>
  ${body}</div>`;
}

// ------------------------------------------------------------- editor view

function editorView() {
  const c = S.campaign;
  const stats = c.outcome?.delivery_stats ?? c.stats ?? null;
  const locked = readOnly() || busy() || unresolved();
  return `<div class="gadget">
  <button class="back-link" data-action="list" data-key="back-list">${icon("back")}${t("All campaigns", "全部活動")}</button>
  <div class="editor-head"><div class="grow"><h1>${esc(c.title || t("Untitled campaign", "未命名活動"))}</h1><div class="meta">${statusBadge(c)}<span>${dirty() ? t("Unsaved changes", "有尚未儲存的變更") : t(`Saved · revision ${c.revision}`, `已儲存 · 版本 ${c.revision}`)}</span></div></div>
  <div class="heading-actions">${button("save", S.busy === "save" ? t("Saving…", "儲存中…") : t("Save draft", "儲存草稿"), { ic: S.busy === "save" ? "refresh" : "check", disabled: locked || !dirty(), extra: S.busy === "save" ? 'aria-busy="true"' : "" })}${button("test", t("Send test", "傳送測試"), { ic: "send", disabled: locked || !capOk("email_sender") || !capOk("favcrm_connector") })}${button("delete", icon("trash"), { kind: "quiet icon", disabled: locked, extra: `aria-label="${t("Delete draft", "刪除草稿")}"` })}</div></div>
  ${readOnly() ? notice(t("Read-only campaign", "唯讀活動"), c.upstreamOnly ? t("This campaign exists in FavCRM only — shown here for reference.", "此活動僅存在於 FavCRM，在此僅供參考。") : t("Your access allows you to inspect this draft.", "您的權限允許您檢視此草稿。")) : ""}
  ${unresolved() ? notice(t("A send is awaiting confirmation", "一項傳送正在等待確認"), t("Keep this draft unchanged until the delivery status is confirmed.", "請待傳送狀態確認後，再修改此草稿。"), "warn", button("recheck", t("Check status", "檢查狀態"))) : ""}
  ${c.status === "approved" && c.draft?.scheduled_for ? notice(t("Scheduled — this draft is locked", "已排程 — 此草稿已鎖定"), formatSchedule(c.draft.scheduled_for) + " · " + t("Unschedule to make changes.", "取消排程後方可修改。"), "", button("schedule", t("Manage schedule", "管理排程"), { kind: "quiet", ic: "calendar" })) : ""}
  ${c.status === "queued" ? notice(t("Queued — undo window open", "已加入佇列 — 可撤回"), t("The send is staged and can still be undone. Nothing leaves while this window is open.", "傳送已暫存，仍可撤回。在此期間不會發出任何電郵。"), "success", button("undo", t("Undo send", "撤回傳送"), { key: "undo" })) : ""}
  ${stats ? `<div class="door-strip">${[["sent", "Sent", "已傳送"], ["delivered", "Delivered", "已送達"], ["bounced", "Bounced", "退信"], ["failed", "Failed", "失敗"]].map(([k, en, zh]) => `<span class="door-pill"><strong>${number(stats[k] ?? 0)}</strong><span>${t(en, zh)}</span></span>`).join("")}<span class="door-pill gap">${t("Receipts reconcile as providers report — no opens are invented", "回執按服務商回報對帳——不會虛構開啟率")}</span></div>` : ""}
  <nav class="steps" aria-label="${t("Campaign steps", "活動步驟")}">${[[0, "Audience", "收件對象"], [1, "Content", "內容"], [2, "Review & send", "審閱及傳送"]]
    .map(([i, en, zh]) => `${i ? icon("chev").replace("<svg", '<svg class="step-arrow"') : ""}<button class="step ${S.step === i ? "active" : ""}" data-action="step" data-value="${i}" data-key="step-${i}" ${S.step === i ? 'aria-current="step"' : ""}><span class="step-number">${i + 1}</span>${t(en, zh)}</button>`)
    .join("")}</nav>
  ${S.proposals.length ? `<div class="proposal-line"><span class="spark">${icon("spark")}</span><div class="grow"><strong>${t(`${S.proposals.length} suggestion${S.proposals.length === 1 ? "" : "s"} from your assistant`, `助理提出了 ${S.proposals.length} 項建議`)}</strong> <span class="muted">${esc(S.proposals[0].label || t("A change to this draft.", "對此草稿的修改。"))}</span></div>${button("proposal", t("Review suggestion", "審閱建議"), { kind: "quiet", ic: "chev" })}</div>` : ""}
  ${S.step === 0 ? audienceStep() : S.step === 1 ? contentStep() : reviewStep()}</div>`;
}

// ---------------------------------------------------------- audience step

function audienceStep() {
  const d = S.edit ?? normalizeDraft({});
  const e = S.campaign?.estimate ?? null;
  const stale = estimateStale();
  const locked = readOnly() || busy() || unresolved();
  const seg = d.audience_segment[0]?.segment_id ?? "";
  const left = !capOk("favcrm_connector")
    ? `<div class="grant-card"><div class="flex">${icon("plug")}<strong>${t("Connect FavCRM to choose an audience", "連接 FavCRM 以選擇收件對象")}</strong></div><p>${t("Segments, customers, consent and delivery all live there. Until then this draft keeps references you cannot resolve — which is why the bot will not invent one.", "客戶群組、客戶、同意狀態及傳送均於該處管理。連接前，此草稿只保留未能解析的參照——機械人因此不會虛構名單。")}</p>${button("grant-favcrm", t("Connect FavCRM", "連接 FavCRM"), { kind: "primary", key: "grant-favcrm-panel" })}</div>`
    : `<div class="form-section"><div class="section-heading"><h3>${t("Who receives it", "收件對象")}</h3></div>
    <div class="choice-row" role="group" aria-label="${t("Audience source", "收件對象來源")}">${[["all", "All customers", "所有客戶"], ["segment", "A segment", "客戶群組"], ["individual", "Choose customers", "指定客戶"]]
      .map(([v, en, zh]) => `<button data-action="source" data-value="${v}" data-key="source-${v}" class="${d.audience_source === v ? "active" : ""}" aria-pressed="${d.audience_source === v}" ${locked ? "disabled" : ""}>${t(en, zh)}</button>`)
      .join("")}</div>
    ${d.audience_source === "segment" ? `<div class="field"><label for="segment">${t("Segment", "客戶群組")}</label><select id="segment" data-field="segment" data-key="segment" ${locked ? "disabled" : ""}>${S.segments.map((s) => `<option value="${esc(s.segment_id ?? s.id)}" ${seg === (s.segment_id ?? s.id) ? "selected" : ""}>${esc(s.label ?? s.name ?? s.segment_id ?? s.id)}</option>`).join("")}</select></div>` : ""}
    ${d.audience_source === "individual" ? `<div class="field"><label for="cust-q">${t("Add customers", "加入客戶")}</label><input id="cust-q" data-field="customerQuery" data-key="cust-q" value="${esc(S.customerQuery)}" placeholder="${t("Search name or email", "搜尋名稱或電郵")}" ${locked ? "disabled" : ""}>${results(S.customerQuery, "account", locked)}${chips(d.audience_accounts, "account")}</div>` : ""}
    </div>
    <div class="form-section"><div class="section-heading"><h3>${t("Exclusions", "排除對象")}</h3><p>${t("Skip people who already got a campaign, or named customers.", "排除已接收某活動或指定的客戶。")}</p></div>
    <div class="field"><input data-field="exclusionQuery" data-key="excl-q" value="${esc(S.exclusionQuery)}" placeholder="${t("Search customers or campaigns", "搜尋客戶或活動")}" ${locked ? "disabled" : ""}>${results(S.exclusionQuery, "exclusion", locked)}${chips(d.audience_exclusions, "exclusion")}</div></div>`;
  const right = `<div class="summary-panel"><div class="flex between"><h3 style="margin:0">${t("Audience estimate", "收件人數預估")}</h3><span class="status ${stale ? "warning" : "ready"}">${t(stale ? "Refresh needed" : "Up to date", stale ? "需要更新" : "已更新")}</span></div>
  ${capOk("favcrm_connector") && e
    ? [["total", "Selected audience", "已選取的收件對象"], ["excluded", "Manually excluded", "手動排除"], ["missing", "No email address", "沒有電郵地址"], ["consent", "No marketing consent", "未同意接收推廣"], ["opted", "Unsubscribed", "已取消訂閱"]]
        .map(([key, en, zh]) => `<div class="metric-line"><span>${t(en, zh)}</span><strong>${stale ? "—" : `${key === "total" ? "" : "−"}${number(e[key] ?? 0)}`}</strong></div>`)
        .join("") + `<div class="metric-line total"><span>${t("Eligible recipients", "符合資格的收件人")}</span><strong>${stale ? "—" : number(e.eligible ?? 0)}</strong></div>`
    : `<p class="side-caption">${t("Connect FavCRM to measure eligibility — consent is rechecked at send time.", "連接 FavCRM 以計算資格——傳送時會再次檢查同意狀態。")}</p>`}
  ${capOk("favcrm_connector") ? `<div style="margin-top:15px">${button("estimate", S.busy === "estimate" ? t("Measuring…", "計算中…") : t("Refresh estimate", "更新預估"), { kind: "quiet", ic: "refresh", disabled: locked, extra: S.busy === "estimate" ? 'aria-busy="true"' : "" })}</div>` : ""}</div>
  <p class="side-caption">${t("This is an estimate, not a reserved recipient list. Consent and eligibility are checked again when the campaign is sent.", "此數字為預估，並非已固定的收件人清單。傳送時將再次檢查同意狀態及資格。")}</p>`;
  return `<div class="editor-grid"><div>${field("title", t("Campaign name", "活動名稱"), S.campaign?.title ?? "", { disabled: locked })}${left}</div><div>${right}</div></div>`;
}

// ------------------------------------------------------------ content step

function contentStep() {
  const d = S.edit ?? normalizeDraft({});
  const locked = readOnly() || busy() || unresolved();
  const blockEditor = (s) => {
    const meta = SECTION_META[s.type] ?? SECTION_META.body;
    const moves = `<div class="block-moves">${["up", "down"].map((dir) => `<button class="btn quiet icon" data-action="block-${dir}" data-key="${dir}-${esc(s.id)}" data-id="${esc(s.id)}" aria-label="${t(dir === "up" ? "Move up" : "Move down", dir === "up" ? "上移" : "下移")}" ${locked ? "disabled" : ""}>${icon(dir === "up" ? "up" : "down")}</button>`).join("")}<button class="btn quiet icon" data-action="block-del" data-id="${esc(s.id)}" data-key="del-${esc(s.id)}" aria-label="${t("Delete block", "刪除區塊")}" ${locked ? "disabled" : ""}>${icon("trash")}</button></div>`;
    let body = "";
    if (s.type === "heading") body = `<input data-block="${esc(s.id)}" data-bf="heading" value="${esc(s.heading)}" placeholder="${t("Heading", "標題")}" ${locked ? "disabled" : ""}>`;
    else if (s.type === "body") body = `<textarea data-block="${esc(s.id)}" data-bf="body" placeholder="${t("Write the message…", "撰寫內容…")}" ${locked ? "disabled" : ""}>${esc(s.body)}</textarea>`;
    else if (s.type === "cta") body = `<input data-block="${esc(s.id)}" data-bf="cta_label" value="${esc(s.cta_label)}" placeholder="${t("Button label", "按鈕文字")}" ${locked ? "disabled" : ""}><div style="height:8px"></div><input data-block="${esc(s.id)}" data-bf="cta_url" value="${esc(s.cta_url)}" placeholder="https://" ${locked ? "disabled" : ""}>`;
    else if (s.type === "image") body = `<input data-block="${esc(s.id)}" data-bf="image_url" value="${esc(s.image_url)}" placeholder="${t("Image URL (https://…)", "圖片網址（https://…）")}" ${locked ? "disabled" : ""}>`;
    return `<div class="block"><div class="block-title"><span class="block-icon">${icon(meta[2])}${t(meta[0], meta[1])}</span>${moves}</div>${body}</div>`;
  };
  const left = `${field("subject", t("Subject", "主旨"), d.subject, { disabled: locked })}<div style="height:14px"></div>${field("preheader", t("Preheader", "預覽文字"), d.preheader, { disabled: locked, hint: t("Shown beside the subject in the inbox list.", "於收件匣列表中顯示在主旨旁。") })}<div class="form-section" style="margin-top:26px"><div class="section-heading"><div><h3>${t("Sections", "內容區塊")}</h3><p>${t("The exact message the approval binds.", "核准所綁定的確切內容。")}</p></div></div>
    ${d.sections.map(blockEditor).join("")}
    <div class="add-blocks">${Object.keys(SECTION_META).map((k) => `<button class="btn quiet" data-action="add-block" data-value="${k}" data-key="add-${k}" ${locked ? "disabled" : ""}>${icon("plus")}${t(...[SECTION_META[k][0], SECTION_META[k][1]])}</button>`).join("")}</div></div>`;
  const right = `<div class="preview-column"><div class="preview-tools"><span class="eyebrow">${t("Preview", "預覽")}</span><div class="device-toggle"><button class="btn ${S.device === "desktop" ? "active" : ""}" data-action="device" data-value="desktop" data-key="dev-desktop" aria-label="${t("Desktop preview", "桌面預覽")}">${icon("monitor")}</button><button class="btn ${S.device === "mobile" ? "active" : ""}" data-action="device" data-value="mobile" data-key="dev-mobile" aria-label="${t("Mobile preview", "手機預覽")}">${icon("phone")}</button></div></div>
  <div class="preview-stage ${S.device === "mobile" ? "mobile" : ""}"><div class="envelope-meta"><div><span class="faint">${t("From", "寄件者")}</span> <strong>${esc(S.sender?.from_name && S.sender?.from_email ? `${S.sender.from_name} <${S.sender.from_email}>` : S.sender?.from_email ?? t("No sender verified", "尚未驗證寄件者"))}</strong></div><strong>${esc(d.subject || t("(no subject)", "（無主旨）"))}</strong><span class="faint">${esc(d.preheader)}</span></div>
  <div class="mail-body">${d.sections
    .map((s) =>
      s.type === "heading"
        ? `<h2>${esc(s.heading)}</h2>`
        : s.type === "body"
          ? `<p>${esc(s.body)}</p>`
          : s.type === "cta"
            ? `<a class="mail-cta" href="#" onclick="return false">${esc(s.cta_label || "Button")}</a>`
            : `<div class="mail-img">${t("Image", "圖片")}</div>`
    )
    .join("")}
  <div class="mail-foot">${esc(S.sender?.from_name ?? "")}${t(" · legal footer appended by the platform", " · 平台附加的法律頁尾")}<br>${t("Unsubscribe · Preferences — always present on send", "取消訂閱 · 設定偏好——傳送時必定附上")}</div></div></div>
  <p class="preview-note compliance">${icon("shield")}<span>${t("The platform adds identity, legal footer and unsubscribe to every send — the editor cannot remove them.", "平台會為每次傳送附加身分、法律頁尾及取消訂閱——編輯器無法移除。")}</span></p></div>`;
  return `<div class="editor-grid"><div>${left}</div><div>${right}</div></div>`;
}

// ------------------------------------------------------------- review step

function reviewStep() {
  const c = S.campaign;
  const d = S.edit ?? normalizeDraft({});
  const e = c?.estimate ?? null;
  const locked = readOnly() || busy() || unresolved();
  const stale = estimateStale();
  const miss = missing();
  const sendable = !miss.length && !locked && !stale && !(e && !e.eligible) && capOk("favcrm_connector") && capOk("email_sender");
  const isScheduled = Boolean(d.scheduled_for);
  const check = (ok, en, zh, extra = "") => `<div class="check-row ${ok ? "ok" : "warn"}">${icon(ok ? "check" : "clock")}<span>${t(en, zh)}${extra ? ` <span class="faint">${extra}</span>` : ""}</span></div>`;
  const left = `<div class="review-card"><h3>${t("Before this can send", "傳送前檢查")}</h3><div class="checklist">
    ${check(d.subject && d.sections.length, "Subject and content are set", "主旨及內容已完成")}
    ${check(capOk("favcrm_connector"), "Audience resolves through FavCRM", "收件對象經 FavCRM 解析", capOk("favcrm_connector") ? "" : t("— connect to estimate", "— 連接後方可預估"))}
    ${check(capOk("email_sender"), "A verified sender is configured", "已設定驗證寄件者", capOk("email_sender") ? S.sender?.from_email ?? "" : "")}
    ${check(e && !stale, "Audience estimate is current", "收件人數預估已更新", stale ? t("— refresh it", "— 請更新") : "")}
    ${check(true, "Consent, unsubscribe and bounce rules apply at send time", "傳送時將套用同意、取消訂閱及退信規則")}
    ${check(true, "Approval binds this exact revision — any later edit needs a fresh approval", "核准將綁定此版本——其後修改需重新核准")}
  </div></div>
  <div class="review-card"><h3>${t("Timing", "傳送時間")}</h3><div class="timing">
    <label><input type="radio" name="timing" data-field="timing" value="now" ${!isScheduled ? "checked" : ""} ${locked ? "disabled" : ""}><span>${t("Send on approval", "核准後傳送")}<small>${t("Queued as soon as you approve.", "核准後立即加入佇列。")}</small></span></label>
    <label><input type="radio" name="timing" data-field="timing" value="later" ${isScheduled ? "checked" : ""} ${locked || !capOk("schedule") ? "disabled" : ""}><span>${t("Schedule", "排程傳送")}<small>${t("The approval binds this time; changing it re-asks.", "核准將綁定此時間；更改需重新核准。")}</small><input type="datetime-local" data-field="schedule" data-key="sched" value="${esc(d.scheduled_for)}" ${!isScheduled || locked || !capOk("schedule") ? "disabled" : ""}></span></label>
  </div>${!capOk("schedule") ? `<p class="hint" style="margin-top:10px">${t("Scheduling is a door this workspace has not granted — sends stay on approval only.", "此工作區尚未授予排程功能——傳送僅限核准後立即執行。")} ${button("grant-schedule", t("Allow scheduling", "允許排程"), { kind: "quiet", key: "grant-sched-inline" })}</p>` : ""}</div>`;
  const right = `<div class="summary-panel"><h3 style="margin:0 0 12px">${t("What approval binds", "核准所綁定的內容")}</h3><div class="fingerprint">
    <div class="row"><span>${t("Revision", "版本")}</span><strong>${c?.revision ?? 0}${dirty() ? " + " + t("unsaved edits", "未儲存修改") : ""}</strong></div>
    <div class="row"><span>${t("Subject", "主旨")}</span><strong>${esc(d.subject || "—")}</strong></div>
    <div class="row"><span>${t("Sections", "區塊")}</span><strong>${d.sections.length}</strong></div>
    <div class="row"><span>${t("Audience", "收件對象")}</span><strong>${capOk("favcrm_connector") ? sourceLabel(d) : t("Unresolved — no CRM", "未解析 — 無 CRM")}</strong></div>
    <div class="row"><span>${t("Eligible now", "目前符合資格")}</span><strong>${capOk("favcrm_connector") && e && !stale ? number(e.eligible ?? 0) : "—"}</strong></div>
    <div class="row"><span>${t("Sender", "寄件者")}</span><strong>${capOk("email_sender") ? esc(S.sender?.from_email ?? "—") : "—"}</strong></div>
    <div class="row"><span>${t("Timing", "時間")}</span><strong>${!isScheduled ? t("On approval", "核准後") : formatSchedule(d.scheduled_for)}</strong></div>
  </div>
  <div style="margin-top:18px;display:grid;gap:8px">${button("test", t("Send test to yourself", "傳送測試至本人"), { kind: "quiet", ic: "send", disabled: locked || !capOk("email_sender") || !capOk("favcrm_connector") })}${button("review-send", isScheduled ? t("Approve & schedule", "核准並排程") : t("Approve & send", "核准並傳送"), { kind: "primary", ic: "shield", disabled: !sendable || dirty() })}</div>
  ${dirty() ? `<p class="hint" style="margin-top:10px">${t("Save first — approval binds a saved revision, not your open edits.", "請先儲存——核准綁定已儲存的版本，而非未儲存的修改。")}</p>` : ""}</div>`;
  return `<div class="review-grid"><div>${left}</div><div>${right}</div></div>`;
}

// ------------------------------------------------------------------ dialogs

export function openGrant(key) {
  S.grantKey = key;
  const conf = {
    favcrm_connector: {
      title: t("Connect FavCRM", "連接 FavCRM"),
      desc: t("The bot is asking for access to one connector binding.", "機械人要求存取一個連接器綁定。"),
      what: t("Reads segments and customers; creates and sends campaigns through FavCRM's queue. Consent, unsubscribe and suppression stay there.", "讀取客戶群組及客戶；經 FavCRM 佇列建立及傳送活動。同意、取消訂閱及遏抑名單仍由 FavCRM 管理。"),
      scope: t("FavCRM connector · this workspace", "FavCRM 連接器 · 此工作區")
    },
    schedule: {
      title: t("Allow scheduling", "允許排程"),
      desc: t("The bot is asking to arm campaign send times.", "機械人要求設定活動傳送時間。"),
      what: t("Lets an approved send wait for a future time instead of going on approval. Arming and cancelling are both governed.", "允許已核准的傳送等待指定時間執行。設定及取消均受管治。"),
      scope: t("Schedule door · this gadget only", "排程功能 · 僅限此小工具")
    },
    workspace: {
      title: t("Allow notifications", "允許通知"),
      desc: t("The bot is asking to post workspace notifications.", "機械人要求發佈工作區通知。"),
      what: t("A short message when a send finishes, fails, or waits on a decision.", "傳送完成、失敗或等候決定時的簡短訊息。"),
      scope: t("Workspace door · this gadget only", "工作區功能 · 僅限此小工具")
    }
  };
  const c = conf[key] ?? { title: key, desc: "", what: "", scope: "" };
  const interimNote = cap(key).interim
    ? `<p class="dialog-help">${t("This capability names a platform door kind that has not landed yet — the request may find nothing to grant yet. Drafting still works.", "此功能指向平台尚未提供的功能門——授權請求暫時可能找不到可授予的項目。草擬仍可使用。")}</p>`
    : "";
  dialogShell(
    c.title,
    c.desc,
    `<div class="provider-note">${icon("info")}<span>${c.what}</span></div><div class="grant-scope">${icon("door")}<div class="grow"><strong>${c.scope}</strong><small>${t("Requested by the Email campaigns bot — granted by you, revocable later.", "由電郵活動機械人提出——由您授予，日後可撤銷。")}</small></div></div><label class="grant-scope" style="cursor:pointer"><input type="checkbox" id="grant-persist"><span>${t("Also allow on every assistant in this workspace", "同時允許此工作區的所有助理")}<small>${t("Off means this conversation only — the usual choice.", "關閉則僅限此對話——一般建議如此。")}</small></span></label>${interimNote}`,
    `${button("deny", t("Not now", "暫不授權"), { kind: "quiet", key: "deny" })}${button("grant", t("Grant", "授予"), { kind: "primary", key: "grant" })}`
  );
}

export function openSender() {
  dialogShell(
    t("Sender identity", "寄件者身分"),
    t("The address campaigns are sent from, verified through your email provider.", "活動的寄件地址，經您的電郵服務商驗證。"),
    `<div class="field"><label for="provider">${t("Provider", "服務商")}</label><select id="provider" data-field="provider" data-key="provider">${["resend", "cloudflare", "smtp"].map((p) => `<option value="${p}" ${S.provider === p ? "selected" : ""}>${p === "resend" ? "Resend" : p === "cloudflare" ? "Cloudflare Email" : "SMTP relay"}</option>`).join("")}</select></div>
    ${field("sender-name", t("Sender name", "寄件者名稱"), S.sender?.from_name ?? "")}
    ${field("sender-from", t("From address", "寄件地址"), S.sender?.from_email ?? "", { type: "email" })}
    <div class="provider-note">${icon("info")}<span>${t("API keys stay with the platform's provider config — the bot never sees them.", "API 金鑰由平台的服務商設定保管——機械人不會接觸。")}</span></div>`,
    `${button("close-dialog", t("Cancel", "取消"), { kind: "quiet", key: "sender-cancel" })}${button("connect-sender", S.busy === "sender" ? t("Verifying…", "驗證中…") : t("Verify & save", "驗證並儲存"), { kind: "primary", key: "connect-sender" })}`,
    true
  );
}

export function openProposal() {
  const p = S.proposals[0];
  const commands = p?.payload?.commands ?? [];
  dialogShell(
    t("Suggested change", "建議修改"),
    t("From the assistant. Applying edits this draft — it never approves a send.", "助理建議。套用只會修改草稿——不會核准傳送。"),
    `<div class="dialog-summary"><div class="metric-line"><span>${t("Suggestion", "建議")}</span><strong>${esc(p?.label || t("A change to this draft", "對此草稿的修改"))}</strong></div><div class="metric-line"><span>${t("Edits", "修改")}</span><strong>${commands.length}</strong></div></div>
    <p class="dialog-help">${t(`Staged against revision ${p?.baseRevision ?? S.campaign?.revision ?? 0} — applies as one revision.`, `就版本 ${p?.baseRevision ?? S.campaign?.revision ?? 0} 提出——套用為單一版本。`)}</p>`,
    `${button("dismiss-proposal", t("Dismiss suggestion", "忽略建議"), { kind: "quiet", key: "dismiss" })}${button("accept-proposal", t("Apply to draft", "套用到草稿"), { kind: "primary", key: "accept-proposal" })}`
  );
}

export function openConfirm() {
  const c = S.campaign;
  const d = S.edit ?? normalizeDraft({});
  const e = c?.estimate ?? null;
  const isScheduled = Boolean(d.scheduled_for);
  dialogShell(
    isScheduled ? t("Approve and schedule?", "核准並排程？") : t("Approve and send?", "核准並傳送？"),
    t("This is the one irreversible step. The approval binds exactly what is below — any later edit starts a new revision and needs a fresh approval.", "這是唯一不可逆的步驟。核准將綁定下列確切內容——其後任何修改均會建立新版本，並需重新核准。"),
    `<div class="dialog-summary"><div class="metric-line"><span>${t("To", "收件對象")}</span><strong>${sourceLabel(d)}</strong></div><div class="metric-line"><span>${t("Eligible recipients", "符合資格收件人")}</span><strong>${e ? number(e.eligible ?? 0) : "—"}</strong></div><div class="metric-line"><span>${t("From", "寄件者")}</span><strong class="email-mono">${esc(S.sender?.from_email ?? "—")}</strong></div><div class="metric-line"><span>${t("Revision", "版本")}</span><strong>${c?.revision ?? 0}</strong></div><div class="metric-line"><span>${t("When", "時間")}</span><strong>${isScheduled ? formatSchedule(d.scheduled_for) : t("On approval", "核准後")}</strong></div></div>
  <p class="dialog-help">${t("Consent, unsubscribe and bounce rules are rechecked per recipient at send time; a change there shrinks the audience, never widens it.", "傳送時會按收件人再次檢查同意、取消訂閱及退信規則；其結果只會縮小而不會擴大收件範圍。")}</p>`,
    `${button("close-dialog", t("Keep editing", "繼續編輯"), { kind: "quiet", key: "keep-editing" })}${button("confirm-send", isScheduled ? t("Approve & schedule", "核准並排程") : t("Approve & send", "核准並傳送"), { kind: "primary", key: "confirm-send", extra: "data-autofocus" })}`
  );
}

export function openConflict() {
  const c = S.campaign;
  dialogShell(
    t("Saved changes exist elsewhere", "他處已有新儲存"),
    t(`A newer revision was saved while you edited revision ${c?.revision ?? "—"}. Nothing is overwritten until you choose.`, `您編輯版本 ${c?.revision ?? "—"} 期間，已有更新版本儲存。在您選擇前不會覆寫任何內容。`),
    `<div class="conflict-choice"><label><input type="radio" name="conflict" data-field="conflictChoice" value="mine" ${S.conflictChoice !== "theirs" ? "checked" : ""}>${t("Keep my text", "保留我的內容")}</label><p>“${esc(S.edit?.subject ?? "")}”</p></div>
  <div class="conflict-choice"><label><input type="radio" name="conflict" data-field="conflictChoice" value="theirs" ${S.conflictChoice === "theirs" ? "checked" : ""}>${t("Take the saved revision", "採用已儲存版本")}</label><p>“${esc(c?.draft?.subject ?? "")}” <span class="faint">· rev ${c?.revision ?? "—"}</span></p></div>`,
    `${button("close-dialog", t("Keep both open", "稍後決定"), { kind: "quiet", key: "conflict-later" })}${button("resolve-conflict", t("Apply choice", "套用選擇"), { kind: "primary", key: "resolve" })}`
  );
}

export function openScheduleManage() {
  const c = S.campaign;
  dialogShell(
    t("Manage schedule", "管理排程"),
    t("This campaign is approved for " + formatSchedule(c?.draft?.scheduled_for) + ".", "此活動已核准於 " + formatSchedule(c?.draft?.scheduled_for) + " 傳送。"),
    `${field("reschedule", t("New time", "新時間"), c?.draft?.scheduled_for ?? "", { type: "datetime-local" })}<p class="dialog-help">${t("Rescheduling binds a new approval to the same revision. Unscheduling returns the draft to editable.", "更改時間會就同一版本重新核准。取消排程可再次編輯草稿。")}</p>`,
    `${button("unschedule", t("Unschedule", "取消排程"), { kind: "quiet", key: "unschedule" })}${button("reschedule", t("Reschedule", "更改時間"), { kind: "primary", key: "reschedule" })}`
  );
}
