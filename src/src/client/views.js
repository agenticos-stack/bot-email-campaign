// Email Campaign client — the views the accepted campaigns-revamp mockup
// defines, rendered off `S` (state.js) and the facet's draft model.
//
// The markup is the mockup's: `.page-head` frame (crumb, `.page-title`,
// `.page-sub`), the collection inside a bordered `.card` (`.card-head` tile +
// count/sort meta + `.search`, `.filterbar` `.filters` pills with counts,
// `.table`/`.cardlist`, `.card-foot` provenance), the `.stepper` composer
// (.step + .step-dot + .step-line), `.choice` radio cards, `.checks`
// blockers/advisories, `.section-block` typed editor with `n / 40`, and the
// `.preview-frame` live mail preview (`.segmented` desktop/mobile + `.foot`
// unsubscribe). Loading/error hold the page geometry — `.skeleton` rows plus
// the facet's real refusal and a retry.
//
// Every function returns an HTML string; every untrusted value passes
// through `esc()` at the render site. There is no raw-HTML escape hatch.

import { EMAIL_CAMPAIGN_DEFINITION } from "../../../definition.ts";
import { normalizeDraft } from "../../model.js";
import { button, dialogShell, esc, field, icon } from "./dom.js";
import { formatSchedule, number, t } from "./i18n.js";
import {
  S,
  busy,
  dirty,
  estimateStale,
  filterTabs,
  missing,
  readOnly,
  recipientsOf,
  reviewStateOf,
  sourceLabel,
  statusChip,
  unresolved,
  when
} from "./state.js";

// ---------------------------------------------------------------- helpers

const SECTION_LIMIT = EMAIL_CAMPAIGN_DEFINITION.fields.find((f) => f.key === "sections")?.maxItems ?? 40;

const cap = (key) => S.capabilities?.[key] ?? { granted: false, interim: false };
const capOk = (key) => cap(key).granted === true;

/** Section type → [en, zh] + icon, for the block bar and the add-block row. */
const SECTION_META = {
  heading: ["Heading", "標題", "heading"],
  body: ["Body", "文字", "text"],
  cta: ["Button", "按鈕", "link"],
  image: ["Image", "圖片", "image"],
  custom_html: ["HTML", "自訂 HTML", "code"]
};

const TILE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`;

/** iconbtn — the mockup's small square ghost icon control. */
function iconBtn(action, label, ic, { id = "", value = "", key = "", disabled = false } = {}) {
  return `<button class="iconbtn" type="button" data-action="${esc(action)}" aria-label="${esc(label)}" data-key="${esc(key || `${action}-${id || value}`)}"${id ? ` data-id="${esc(id)}"` : ""}${value ? ` data-value="${esc(value)}"` : ""}${disabled ? " disabled" : ""}><span class="icon">${icon(ic)}</span></button>`;
}

/** The mockup's status badge — dot + label on a toned pill. */
function badge(label, tone = "neutral") {
  return `<span class="badge${tone && tone !== "neutral" ? ` badge--${esc(tone)}` : ""}"><span class="dot"></span>${esc(label)}</span>`;
}

function stateBadge(campaign) {
  const c = statusChip(campaign);
  return badge(t(...c.label), c.tone);
}

function dlRow(label, valueHtml) {
  return `<div><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

/** A mockup `.check` row — mark, title, optional why + fix link. */
function checkRow(kind, title, { why = "", fix = "", action = "", value = "", id = "" } = {}) {
  return `<div class="check check--${esc(kind)}">
    <span class="check-mark">${icon(kind === "ok" ? "check" : kind === "block" ? "alert" : "info")}</span>
    <div class="check-body">
      <div class="check-title">${esc(title)}</div>
      ${why ? `<div class="check-why">${esc(why)}</div>` : ""}
      ${fix ? `<button class="check-fix" type="button" data-action="${esc(action)}"${value ? ` data-value="${esc(value)}"` : ""}${id ? ` data-id="${esc(id)}"` : ""}>${esc(fix)}${icon("chev")}</button>` : ""}
    </div>
  </div>`;
}

/** Audience search results — connector answers only, chips for chosen rows. */
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
        `<button class="result" type="button" data-action="add-${kind}" data-id="${esc(c.account_id ?? c.id)}" data-key="res-${kind}-${esc(c.account_id ?? c.id)}"><span class="grow"><strong>${esc(c.name ?? c.label)}</strong><span class="faint">${esc(c.email ?? c.kind ?? "")}</span></span>${icon("plus")}</button>`
    )
    .join("")}</div>`;
}

function chips(items, kind) {
  if (!items?.length) return "";
  return `<div class="chips">${items
    .map(
      (c) =>
        `<span class="chip">${c.kind === "campaign" ? badge(t("Campaign", "活動")) : ""}${esc(c.name ?? c.label)}${
          !readOnly()
            ? `<button type="button" data-action="remove-${kind}" data-id="${esc(c.account_id ?? c.id)}" data-key="remove-${kind}-${esc(c.account_id ?? c.id)}" aria-label="${t("Remove", "移除")} ${esc(c.name ?? c.label)}">${icon("close")}</button>`
            : ""
        }</span>`
    )
    .join("")}</div>`;
}

/** The mockup's `.strip` — quiet inline status; the icon carries the tone. */
function strip(iconName, textHtml, action = "", tone = "") {
  return `<div class="strip${tone ? ` strip--${esc(tone)}` : ""}" role="${tone === "danger" ? "alert" : "status"}"><span class="strip-icon">${icon(iconName)}</span><span class="strip-text">${textHtml}</span>${action}</div>`;
}

// ------------------------------------------------------------------- frame

/** The Studio page frame — crumb, `.page-title` (+ badge), sub, meta, actions. */
function pageHead({ title, badgeHtml = "", sub = "", meta = "", actions = "" }) {
  return `<header class="page-head">
    <span class="crumb">${icon("grid")}<span>${t("Studio", "工作室")}</span><span aria-hidden="true">›</span><span>${esc(title)}</span></span>
    <div class="page-head-row">
      <div class="title-main">
        <div class="title-line"><h1 class="page-title">${esc(title)}</h1>${badgeHtml}</div>
        ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ""}
        ${meta ? `<p class="page-meta">${meta}</p>` : ""}
      </div>
      <div class="head-actions">${actions}</div>
    </div>
  </header>`;
}

/** Sender strip — the mockup's quiet readiness line under the head. */
function senderStrip() {
  if (S.senderError) {
    // A refused read is shown as itself — "could not check", never "not set".
    return `<div class="strip"><span class="strip-icon warn">${icon("alert")}</span><span class="strip-text">${esc(t(`The sender could not be checked — ${S.senderError}`, `無法檢查寄件者——${S.senderError}`))}</span>${button("sender", t("Set up sender", "設定寄件者"), { kind: "secondary", key: "strip-sender" })}</div>`;
  }
  if (S.sender?.connected && S.sender?.from_email) {
    return strip("mail", esc(t(`Sending as ${S.sender.from_email}`, `寄件者 ${S.sender.from_email} 已驗證`)),
      button("sender", t("Manage", "管理"), { kind: "quiet", key: "strip-sender" }));
  }
  return `<div class="strip"><span class="strip-icon warn">${icon("alert")}</span><span class="strip-text">${esc(t("No verified email sender yet. Sending is blocked until one is verified.", "尚未設定電郵寄件者。完成驗證後才可發送。"))}</span>${button("sender", t("Set up sender", "設定寄件者"), { kind: "secondary", key: "strip-sender" })}</div>`;
}

// --------------------------------------------------------------- list view

function matchesFilter(row) {
  const tab = filterTabs().find((entry) => entry.id === S.filter);
  if (tab?.states) return tab.states.includes(reviewStateOf(row));
  return true;
}

function listRow(row) {
  const editable = row.kind === "draft";
  const provenance = row.kind === "history" ? t("Sent via FavCRM", "經 FavCRM 發送")
    : row.kind === "sibling" ? t("Owned by another gadget", "由另一個小工具管理") : "";
  const subject = row.subject ?? row.draft?.subject ?? "";
  const name = editable
    ? `<button class="row-name" type="button" data-action="open" data-id="${esc(row.id)}" data-key="open-${esc(row.id)}">${esc(row.title)}${subject ? `<span class="row-sub">${esc(subject)}</span>` : ""}</button>`
    : `<span class="row-name is-static">${esc(row.title)}${subject ? `<span class="row-sub">${esc(subject)}</span>` : ""}${provenance ? `<span class="row-sub">${esc(provenance)}</span>` : ""}</span>`;
  return `<tr>
    <td>${name}</td>
    <td>${stateBadge(row)}</td>
    <td class="num">${row.recipients === null || row.recipients === undefined ? `<span class="faint">—</span>` : esc(recipientsOf(row))}</td>
    <td class="when-cell">${esc(when(row.updatedAt))}</td>
    <td class="actions"><span class="row-tools">
      ${editable ? iconBtn("duplicate", t("Duplicate", "複製"), "copy", { id: row.id }) + iconBtn("open", t("Open", "開啟"), "chev", { id: row.id }) : ""}
    </span></td>
  </tr>`;
}

function cardRow(row) {
  const editable = row.kind === "draft";
  return `<div class="cardrow">
    <div class="cardrow-main">
      ${editable
        ? `<button class="row-name" type="button" data-action="open" data-id="${esc(row.id)}" data-key="card-${esc(row.id)}">${esc(row.title)}</button>`
        : `<span class="row-name is-static">${esc(row.title)}</span>`}
      ${(row.subject ?? row.draft?.subject) ? `<span class="row-sub">${esc(row.subject ?? row.draft?.subject)}</span>` : ""}
      <div class="cardrow-meta">
        ${stateBadge(row)}
        <span>${row.recipients === null || row.recipients === undefined ? "—" : `${esc(recipientsOf(row))} ${t("recipients", "位收件者")}`}</span>
        <span>${esc(when(row.updatedAt))}</span>
      </div>
    </div>
    ${editable ? iconBtn("open", t("Open", "開啟"), "chev", { id: row.id, key: `card-open-${row.id}` }) : ""}
  </div>`;
}

function listView() {
  const rows = [
    ...S.campaigns.map((c) => ({ ...c, kind: "draft" })),
    ...S.siblings.map((s) => ({ id: s.id, title: s.title ?? s.label ?? s.id, status: s.status ?? "draft", updatedAt: s.updatedAt ?? "", kind: "sibling", recipients: null })),
    ...S.history.map((h) => ({ id: h.id ?? h.campaign_id, title: h.title ?? h.name ?? h.subject ?? "Campaign", subject: h.subject ?? "", status: "sent", reviewState: "sent", updatedAt: h.updatedAt ?? h.sent_at ?? "", kind: "history", recipients: h.stats?.sent ?? null }))
  ].filter((r) => `${r.title} ${r.subject ?? ""}`.toLowerCase().includes(S.search.toLowerCase()));
  const visible = rows.filter(matchesFilter);
  const tabs = filterTabs();
  const tabCount = (tab) => (tab.states ? rows.filter((r) => tab.states.includes(reviewStateOf(r))).length : rows.length);

  const body = !visible.length
    ? `<div class="empty">
        <span class="tile">${TILE}</span>
        <div><h3>${t("No campaigns yet", "未有推廣活動")}</h3><p>${t("Create your first campaign to email customers who have opted in.", "建立第一個活動，向已同意接收的客戶發送電郵。")}</p>
          <div style="margin-top:12px">${button("new", t("New campaign", "新增活動"), { kind: "secondary", ic: "plus", key: "empty-new" })}</div>
        </div>
      </div>`
    : `<table class="table">
        <thead><tr>
          <th class="col-name">${t("Name", "名稱")}</th>
          <th>${t("Status", "狀態")}</th>
          <th class="num">${t("Recipients", "收件者")}</th>
          <th>${t("Updated", "更新")}</th>
          <th class="actions"><span class="sr-only">${t("Actions", "操作")}</span></th>
        </tr></thead>
        <tbody>${visible.map(listRow).join("")}</tbody>
      </table>
      <div class="cardlist">${visible.map(cardRow).join("")}</div>`;

  return `<div class="gadget">${pageHead({
    title: t("Campaigns", "推廣活動"),
    sub: t("Send bulk email to your customers — drafted, reviewed and sent through the connected CRM.", "向客戶發送批量電郵 — 經由已連接的 CRM 草擬、審閱及發送。"),
    actions: button("new", t("New campaign", "新增活動"), { kind: "brand", ic: "plus", key: "new", disabled: S.readOnly })
  })}
  ${senderStrip()}
  <section class="card">
    <div class="card-head">
      <div class="card-head-id">
        <span class="tile">${TILE}</span>
        <div><h3>${t("All campaigns", "所有活動")}</h3>
          <p class="meta">${t(`${visible.length} item${visible.length === 1 ? "" : "s"} · newest first`, `${visible.length} 項 · 最近更新在前`)}</p></div>
      </div>
      <div class="search">${icon("search")}<input class="field-control" type="search" data-field="list-search" data-key="list-search" value="${esc(S.search)}" placeholder="${t("Search campaigns…", "搜尋活動…")}" aria-label="${t("Search campaigns", "搜尋活動")}"></div>
    </div>
    <div class="filterbar">
      <div class="filters" role="tablist" aria-label="${t("Status", "狀態")}">
        ${tabs.map((tab) => `<button role="tab" type="button" aria-selected="${S.filter === tab.id}" data-action="filter" data-value="${esc(tab.id)}" data-key="filter-${esc(tab.id)}">${esc(t(...tab.label))}<span class="count">${tabCount(tab)}</span></button>`).join("")}
      </div>
      <span class="meta">${t("Select a row to open a campaign", "選擇一行以開啟活動")}</span>
    </div>
    ${body}
    <div class="card-foot">
      <span>${t("Drafts live in this gadget · upstream sends via FavCRM", "草稿存於此小工具 · 上游發送經 FavCRM")}</span>
      ${rows.length ? `<button class="btn quiet" type="button" data-action="load-more" data-key="load-more">${t("Load more", "載入更多")}</button>` : ""}
    </div>
  </section></div>`;
}

// ---------------------------------------------------------------- new view

function newView() {
  return `<div class="gadget">${pageHead({
    title: t("New campaign", "新增活動"),
    sub: t("Name it first — you'll pick the audience, write the content, then review and send.", "先為活動命名，接著設定受眾、內容，再審閱及發送。")
  })}
  <div class="cols new-cols">
    <div class="card"><div class="card-body">
      ${field("newName", t("Campaign name", "活動名稱"), S.newName, { placeholder: t("October member update", "十月會員快訊"), hint: t("Internal name. Customers never see it.", "內部名稱，客戶不會看到。"), required: true })}
      <div class="step-actions">
        ${button("create", t("Create campaign", "建立活動"), { kind: "primary", key: "create", disabled: !S.newName.trim() || S.readOnly })}
        ${button("list", t("Cancel", "取消"), { kind: "quiet", key: "new-cancel" })}
      </div>
    </div></div>
    <aside class="card card--advisory"><div class="card-body">
      <p class="small-label">${t("What comes next", "接下來")}</p>
      <ol class="ahead">${[
        t("Choose who receives it and estimate reach", "選擇收件對象並預估覆蓋"),
        t("Write the subject and the email body", "撰寫主旨及電郵內容"),
        t("Review, send a test, then send", "檢閱、試寄，然後發送")
      ].map((x, i) => `<li><span class="step-dot">${i + 1}</span><span>${esc(x)}</span></li>`).join("")}</ol>
    </div></aside>
  </div></div>`;
}

// ------------------------------------------------------------- editor view

function stepper(active) {
  const steps = [t("Audience", "受眾"), t("Content", "內容"), t("Review & send", "檢閱及發送")];
  return `<nav class="stepper" aria-label="${t("Campaign steps", "活動步驟")}">${steps
    .map((label, i) => {
      const done = i < active;
      return `<button type="button" class="step" data-action="step" data-value="${i}" data-key="step-${i}"${i === active ? ' aria-current="step"' : ""} data-done="${done}">
        <span class="step-dot">${done ? icon("check") : i + 1}</span><span>${esc(label)}</span>
      </button>${i < steps.length - 1 ? '<span class="step-line" aria-hidden="true"></span>' : ""}`;
    })
    .join("")}</nav>`;
}

function editorHead() {
  const c = S.campaign;
  const savedNote = dirty() ? t("unsaved changes", "有未儲存變更") : t("All changes saved", "所有變更已儲存");
  return `${pageHead({
    title: c?.title || t("Untitled campaign", "未命名活動"),
    badgeHtml: stateBadge(c),
    meta: `${t(`Revision ${c?.revision ?? 0}`, `修訂版 ${c?.revision ?? 0}`)} · <span class="${dirty() ? "" : "ok-text"}">${esc(savedNote)}</span> · ${t("Updated", "更新")} ${esc(when(c?.updatedAt))}`,
    actions: `${button("save", S.busy === "save" ? t("Saving…", "儲存中…") : t("Save draft", "儲存草稿"), { kind: "secondary", key: "save", disabled: !dirty() || readOnly() || busy(), extra: S.busy === "save" ? 'aria-busy="true"' : "" })}
      <span class="overflow">${iconBtn("menu", t("More actions", "更多操作"), "dots", { key: "menu" })}
        <span class="menu" role="menu"${S.menuOpen ? "" : " hidden"}>
          <button class="btn quiet" type="button" role="menuitem" data-action="duplicate" data-id="${esc(c?.id ?? "")}" data-key="menu-dup">${icon("copy")}${t("Duplicate", "複製")}</button>
          <button class="btn danger" type="button" role="menuitem" data-action="delete" data-key="menu-del">${icon("trash")}${t("Delete campaign", "刪除活動")}</button>
        </span>
      </span>`
  })}`;
}

function notices() {
  const c = S.campaign;
  const out = [];
  if (!c) return "";
  if (readOnly()) {
    out.push(strip("info", `<strong>${esc(t("Read-only campaign", "唯讀活動"))}</strong><br><span class="faint">${esc(c.upstreamOnly ? t("This campaign exists in FavCRM only — shown here for reference.", "此活動僅存在於 FavCRM，在此僅供參考。") : t("Its content is owned upstream — duplicate it to draft a follow-up.", "內容由上游管理，只供查閱。可以複製為新草稿。"))}</span>`));
  }
  if (unresolved()) {
    out.push(strip("alert", `<strong>${esc(t("A send is awaiting confirmation", "一項傳送正在等待確認"))}</strong><br><span class="faint">${esc(t("Keep this draft unchanged until the delivery status is confirmed.", "請待傳送狀態確認後，再修改此草稿。"))}</span>`,
      button("recheck", t("Check status", "檢查狀態"), { kind: "secondary", key: "recheck" }), "warn"));
  }
  if (S.edit?.unresolved && !dirty()) {
    out.push(strip("alert", `<strong>${esc(t("The stored draft was edited elsewhere", "此草稿曾於其他地方修改"))}</strong><br><span class="faint">${esc(t("Some proposed changes could not be applied. Resolve them, then continue editing.", "部分變更未能套用。請先處理衝突，然後繼續編輯。"))}</span>`,
      button("conflict", t("Resolve", "處理衝突"), { kind: "secondary", key: "conflict" }), "danger"));
  }
  if (!readOnly() && c.status === "approved" && c.draft?.scheduled_for) {
    out.push(strip("clock", `<strong>${esc(t(`Scheduled for ${formatSchedule(c.draft.scheduled_for)}`, `已排程於 ${formatSchedule(c.draft.scheduled_for)} 發送`))}</strong><br><span class="faint">${esc(t("The scheduled send is bound to the saved revision.", "排程以已儲存的修訂版本為準。"))}</span>`,
      button("schedule", t("Manage schedule", "管理排程"), { kind: "quiet", key: "sched-notice" })));
  }
  if (c.status === "queued" && !S.op) {
    out.push(strip("clock", `<strong>${esc(t("Send is queued", "發送已加入佇列"))}</strong><br><span class="faint">${esc(t("The undo window is still open — the send may already have committed upstream.", "撤回期限仍未結束，上游可能已經開始發送。"))}</span>`,
      button("undo", t("Undo send", "撤回傳送"), { kind: "secondary", key: "undo" }), "warn"));
  }
  if (c.outcome?.undo_until) {
    const left = Math.max(0, Math.round((new Date(c.outcome.undo_until).getTime() - Date.now()) / 1000));
    if (left > 0) out.push(strip("check", `<strong>${esc(t(`Sent — ${left}s left to undo`, `已發送 — 撤回期限尚餘 ${left} 秒`))}</strong>`,
      button("undo", t("Undo send", "撤回發送"), { kind: "secondary", key: "undo-sent", disabled: busy() }), "ok"));
  }
  return out.join("");
}

function proposalsStrip() {
  const open = (S.proposals ?? []).filter((p) => p.status === "open" || p.state === "pending");
  if (!open.length) return "";
  const p = open[open.length - 1];
  return strip("spark", `<strong>${esc(t(`Assistant proposal · revision ${p.base_revision ?? "—"}`, `助理建議 · 修訂版本 ${p.base_revision ?? "—"}`))}</strong><br><span class="faint">${esc(p.rationale || t("Changes pending review", "變更待檢閱"))}</span>`,
    button("proposal", t("Review", "檢閱"), { kind: "secondary", key: `prop-${p.id ?? "0"}` }));
}

// --- audience step ----------------------------------------------------------

function audienceStep() {
  const d = S.edit ?? normalizeDraft({});
  const locked = readOnly() || busy() || unresolved();
  const src = d.audience_source;
  const cards = [
    ["all", "All customers", "所有客戶", "Everyone who has consented to marketing email.", "所有已同意接收推廣電郵的客戶。"],
    ["segment", "A customer segment", "客戶分群", "Use a segment already saved in the CRM.", "使用 CRM 已儲存的分群。"],
    ["individual", "Pick customers", "個別選擇客戶", "Choose recipients one by one.", "逐一挑選收件人。"]
  ];
  const seg = d.audience_segment?.[0]?.segment_id ?? "";
  return `<div class="cols">
    <div class="stack">
      <section class="card"><div class="card-body">
        <h2 class="section-title">${t("Who receives this", "收件對象")}</h2>
        <div class="choice-list" role="radiogroup" aria-label="${t("Who receives this", "收件對象")}">
          ${cards.map(([value, en, zh, enBody, zhBody]) => `<label class="choice">
            <input type="radio" name="audience_source" value="${value}" data-field="audience_source"${src === value ? " checked" : ""}${locked ? " disabled" : ""}>
            <span class="choice-main"><span class="choice-title">${t(en, zh)}</span><span class="choice-hint">${t(enBody, zhBody)}</span></span>
          </label>`).join("")}
        </div>
        ${src === "segment" ? `<div class="sub-field">
          <label class="field-label" for="segment">${t("Choose a segment", "選擇分群")}</label>
          ${S.segments.length ? `<select id="segment" class="select-control" data-field="segment" ${locked ? "disabled" : ""}><option value="">${t("Select a segment…", "選擇一個分群…")}</option>${S.segments.map((s) => `<option value="${esc(s.segment_id ?? s.id)}"${seg === (s.segment_id ?? s.id) ? " selected" : ""}>${esc(s.label ?? s.name ?? s.segment_id ?? s.id)}</option>`).join("")}</select>` : `<p class="empty-hint">${capOk("favcrm_connector") ? t("No segments yet — the connector answered but the workspace has none saved.", "尚無客戶分群 — 連接器正常回應，但工作區未儲存任何分群。") : t("Segments arrive once the FavCRM connector is granted.", "取得 FavCRM 連接授權後，即可使用客戶分群。")}</p>`}
        </div>` : ""}
        ${src === "individual" ? `<div class="sub-field">
          <label class="field-label" for="cust-q">${t("Pick customers", "個別選擇客戶")}</label>
          <input id="cust-q" class="field-control" data-field="customerQuery" data-key="cust-q" value="${esc(S.customerQuery)}" placeholder="${t("Search name or email", "搜尋名稱或電郵")}" ${locked ? "disabled" : ""}>
          ${results(S.customerQuery, "account", locked)}
          ${chips(d.audience_accounts, "account")}
        </div>` : ""}
      </div></section>

      <section class="card"><div class="card-body">
        <h2 class="section-title">${t("Exclusions", "排除名單")}</h2>
        <p class="field-hint">${t("Exclude individual customers or the recipients of an earlier campaign — resolved at send time so the count stays accurate.", "排除個別客戶或先前活動的收件者 — 於發送時解析，確保數目準確。")}</p>
        <input class="field-control" data-field="exclusionQuery" data-key="excl-q" value="${esc(S.exclusionQuery)}" placeholder="${t("Search customers or campaigns…", "搜尋客戶或活動…")}" ${locked ? "disabled" : ""}>
        ${results(S.exclusionQuery, "exclusion", locked)}
        ${chips(d.audience_exclusions, "exclusion")}
      </div></section>
    </div>

    <aside class="rail">
      <section class="card">
        <div class="card-head"><h3>${t("Estimated reach", "預計覆蓋")}</h3>
          ${capOk("favcrm_connector") ? button("estimate", S.busy === "estimate" ? t("Measuring…", "計算中…") : t("Recalculate", "重新預估"), { kind: "secondary", ic: "refresh", key: "estimate", disabled: locked, extra: S.busy === "estimate" ? 'aria-busy="true"' : "" }) : ""}</div>
        <div class="card-body">${estimateBody()}</div>
        <div class="card-foot">${t("Consent and opt-outs are counted by the CRM.", "同意及退訂狀態由 CRM 統計。")}</div>
      </section>
    </aside>
  </div>`;
}

function estimateBody() {
  const e = S.campaign?.estimate ?? null;
  const stale = estimateStale();
  if (!capOk("favcrm_connector")) {
    return `<p class="empty-hint">${t("Connect FavCRM to measure eligibility — consent is rechecked at send time.", "連接 FavCRM 以計算資格——傳送時會再次檢查同意狀態。")}</p>`;
  }
  if (!e) return `<p class="empty-hint">${t("No estimate yet. Recalculate to see how many customers qualify.", "尚未預估。按「重新預估」查看符合資格的客戶數目。")}</p>`;
  const rows = [["total", "Selected audience", "客戶總數"], ["excluded", "Manually excluded", "已排除"], ["missing", "No email address", "沒有電郵地址"], ["consent", "No marketing consent", "未同意"], ["opted", "Unsubscribed", "已退訂"]]
    .map(([k, en, zh]) => dlRow(t(en, zh), stale ? "—" : `${k === "total" ? "" : "−"}${number(e[k] ?? 0)}`)).join("");
  return `<dl class="dl">${rows}
    <div class="dl-total"><dt>${t("Eligible recipients", "符合資格")}</dt><dd>${stale ? "—" : number(e.eligible ?? 0)}</dd></div>
  </dl>
  ${stale ? strip("alert", esc(t("The audience changed — recalculate before sending.", "受眾已更改，請重新預估。")), "", "warn") : ""}`;
}

// ------------------------------------------------------------ content step

function blockEditor(s, i, count, locked) {
  const meta = SECTION_META[s.type] ?? SECTION_META.body;
  let body = "";
  if (s.type === "heading") body = `<input class="field-control" data-block="${esc(s.id)}" data-bf="heading" data-key="blk-${esc(s.id)}-h" value="${esc(s.heading)}" placeholder="${t("Block heading", "區塊標題")}" ${locked ? "disabled" : ""}>`;
  else if (s.type === "body") body = `<textarea class="field-control" data-block="${esc(s.id)}" data-bf="body" data-key="blk-${esc(s.id)}-b" rows="4" placeholder="${t("Write this block's content…", "撰寫這一段的內容…")}" ${locked ? "disabled" : ""}>${esc(s.body)}</textarea>`;
  else if (s.type === "cta") body = `<input class="field-control" data-block="${esc(s.id)}" data-bf="cta_label" data-key="blk-${esc(s.id)}-l" value="${esc(s.cta_label)}" placeholder="${t("Button label", "按鈕文字")}" ${locked ? "disabled" : ""}><input class="field-control" style="margin-top:8px" data-block="${esc(s.id)}" data-bf="cta_url" data-key="blk-${esc(s.id)}-u" value="${esc(s.cta_url)}" placeholder="https://" ${locked ? "disabled" : ""}>`;
  else if (s.type === "image") body = `<input class="field-control" data-block="${esc(s.id)}" data-bf="image_url" data-key="blk-${esc(s.id)}-i" value="${esc(s.image_url)}" placeholder="${t("Image URL (https://…)", "圖片網址（https://…）")}" ${locked ? "disabled" : ""}>`;
  else if (s.type === "custom_html") body = `<textarea class="field-control code" data-block="${esc(s.id)}" data-bf="html" data-key="blk-${esc(s.id)}-x" rows="8" placeholder="<!doctype html>…" ${locked ? "disabled" : ""}>${esc(s.html ?? "")}</textarea><p class="field-hint">${t("Sent as-is — the preview renders it in a sandbox, and inboxes strip scripts and forms.", "原樣發送——預覽於沙盒中顯示，收件匣會移除指令碼及表單。")}</p>`;
  return `<div class="section-block">
    <div class="section-bar">
      <span class="badge">${icon(meta[2])} ${t(meta[0], meta[1])}</span>
      <div class="bar-tools">
        ${iconBtn("block-up", t("Move up", "上移"), "up", { id: s.id, disabled: locked || i === 0 })}
        ${iconBtn("block-down", t("Move down", "下移"), "down", { id: s.id, disabled: locked || i === count - 1 })}
        ${iconBtn("block-del", t("Remove", "移除"), "close", { id: s.id, disabled: locked })}
      </div>
    </div>
    <div class="section-body">${body}</div>
  </div>`;
}

function contentStep() {
  const d = S.edit ?? normalizeDraft({});
  const locked = readOnly() || busy() || unresolved();
  const atLimit = d.sections.length >= SECTION_LIMIT;
  return `<div class="cols cols--even">
    <div class="stack">
      <div class="field">
        <label class="field-label" for="subject">${t("Subject", "主旨")}<span class="req">*</span></label>
        <input id="subject" class="field-control" data-field="subject" data-key="subject" value="${esc(d.subject)}" placeholder="${t("First look at the October range", "十月新品率先看")}" ${locked ? "disabled" : ""}>
        <p class="field-hint">${t(`${(d.subject ?? "").length} characters`, `${(d.subject ?? "").length} 字元`)}</p>
      </div>
      ${field("preheader", t("Preheader", "預覽文字"), d.preheader, { disabled: locked, placeholder: t("Members get 10% off for the first two weeks", "三十款新品，會員首兩星期九折"), hint: t("The one line of supporting text the inbox shows next to the subject.", "收件匣在主旨旁顯示的一行補充文字。") })}

      <div>
        <div class="sec-head"><span class="field-label">${t("Email content blocks", "電郵內容區塊")}</span><span class="meta num">${d.sections.length} / ${SECTION_LIMIT}</span></div>
        ${d.sections.length
          ? `<div class="blocks">${d.sections.map((s, i) => blockEditor(s, i, d.sections.length, locked)).join("")}</div>`
          : `<div class="section-empty">${t("No content blocks yet. Pick a type below to add one.", "尚未加入內容區塊。由下方選擇一種加入。")}</div>`}
        <div class="addbar">${Object.keys(SECTION_META).map((k) => button("add-block", t(SECTION_META[k][0], SECTION_META[k][1]), { kind: "secondary", ic: "plus", value: k, key: `add-${k}`, disabled: locked || atLimit })).join("")}</div>
      </div>
    </div>

    <aside class="rail">${previewPane()}</aside>
  </div>`;
}

function previewPane() {
  const d = S.edit ?? normalizeDraft({});
  const sender = S.sender?.from_name || "";
  return `<div class="preview-frame">
    <div class="preview-head">
      <span class="small-label">${t("Preview", "預覽")}</span>
      <div class="segmented" role="group" aria-label="${t("Preview", "預覽")}">
        <button type="button" data-action="device" data-value="desktop" data-key="dev-desktop" aria-pressed="${S.device === "desktop"}">${t("Desktop", "桌面")}</button>
        <button type="button" data-action="device" data-value="mobile" data-key="dev-mobile" aria-pressed="${S.device === "mobile"}">${t("Mobile", "手機")}</button>
      </div>
    </div>
    <div class="mail"><div class="mail-inner ${S.device === "mobile" ? "is-mobile" : ""}">
      <div class="envelope-meta"><span class="faint">${t("From", "寄件者")}</span> <strong>${esc(sender || t("No sender verified", "尚未驗證寄件者"))}</strong><strong>${esc(d.subject || t("(no subject)", "（無主旨）"))}</strong><span class="faint">${esc(d.preheader)}</span></div>
      <div class="mail-body">${d.sections.length
        ? d.sections.map((s) =>
            s.type === "heading"
              ? `<h1>${esc(s.heading)}</h1>`
              : s.type === "body"
                ? `<p>${esc(s.body).replace(/\n/g, "<br>")}</p>`
                : s.type === "cta"
                  ? `<a class="cta" href="#" onclick="return false">${esc(s.cta_label || t("Button", "按鈕"))}</a>`
                  : s.type === "custom_html"
                    // The pasted markup only ever renders inside this empty
                    // sandbox: no scripts, opaque origin, no session reach.
                    ? `<iframe class="mail-html" title="${t("Pasted HTML preview", "貼上 HTML 預覽")}" sandbox referrerpolicy="no-referrer" srcdoc="${esc(s.html || "")}"></iframe>`
                    : `<div class="mail-img">${s.image_url ? `<img src="${esc(s.image_url)}" alt="">` : t("Image", "圖片")}</div>`
          ).join("")
        : `<p class="empty-hint">${t("Add a heading or body block to see the email here.", "加入標題或內文區塊後，此處會顯示電郵預覽。")}</p>`}
        <hr>
        <p class="foot">${esc(sender ? t(`You're receiving this because you're subscribed to updates from ${sender}.`, `你收到此訊息，是因為你訂閱了 ${sender} 的最新消息。`) : t("You're receiving this because you're subscribed to our updates.", "你收到此訊息，是因為你訂閱了我們的最新消息。"))}<br>
          <span class="foot-link">${t("Unsubscribe", "取消訂閱")}</span> — ${esc(t("replaced with the real link on send", "發送時會替換為真實連結"))}</p>
      </div></div></div>
    <p class="preview-note">${icon("shield")}<span>${t("The platform adds identity, legal footer and unsubscribe to every send — the editor cannot remove them.", "平台會為每次傳送附加身分、法律頁尾及取消訂閱——編輯器無法移除。")}</span></p>
  </div>`;
}

// ------------------------------------------------------------- review step

function reviewStep() {
  const c = S.campaign;
  const d = S.edit ?? normalizeDraft({});
  const e = c?.estimate ?? null;
  const locked = readOnly() || busy() || unresolved();
  const stale = estimateStale();
  const miss = missing();
  const isScheduled = Boolean(d.scheduled_for);
  // Refused capability reads say "could not check" with the facet's reason —
  // never "not connected"/"not set", which are findings only an ok read may make.
  const capsUnknown = Boolean(S.capabilitiesError);
  const senderUnknown = Boolean(S.senderError);
  const blocking = [
    { ok: !miss.length, title: t("Subject and content set", "主旨及內容已填寫"), fix: t("Go to content", "前往內容"), action: "step", value: "1" },
    { ok: capOk("favcrm_connector"), title: t("FavCRM is connected", "已連接 FavCRM"),
      why: capsUnknown ? t(`Could not check — ${S.capabilitiesError}`, `無法檢查——${S.capabilitiesError}`) : t("Audience, estimates and delivery go through it.", "受眾、預估及發送都經由連接器。"),
      fix: capsUnknown ? "" : t("Connect", "連接"), action: "grant-favcrm" },
    { ok: capOk("email_sender") && Boolean(S.sender?.from_email), title: t("A verified sender is set", "已設定已驗證的寄件者"),
      why: senderUnknown ? t(`Could not check — ${S.senderError}`, `無法檢查——${S.senderError}`) : capsUnknown ? t(`Could not check — ${S.capabilitiesError}`, `無法檢查——${S.capabilitiesError}`) : t("Set the sending domain and address in sender setup.", "請在寄件者頁設定寄件網域及地址。"),
      fix: senderUnknown || capsUnknown ? "" : t("Go to sender setup", "前往寄件者設定"), action: "sender" },
    { ok: !capOk("favcrm_connector") || !stale, title: t("Audience estimate is current", "客群預估為最新"), why: t("The audience changed after the last estimate.", "受眾在預估後有更改。"), fix: t("Back to audience to recalculate", "回到受眾重新預估"), action: "step", value: "0" },
    { ok: !(e && !stale) || (e.eligible ?? 0) > 0, title: t("At least one eligible recipient", "至少一名合資格收件人"), why: t("Everyone is currently excluded, unsubscribed or has not consented.", "目前所有人均被排除、已退訂或未同意。"), fix: t("Back to audience to adjust", "回到受眾放寬條件"), action: "step", value: "0" }
  ];
  const tips = [
    { ok: Boolean(d.subject), title: t("Subject is filled", "已填寫主旨") },
    { ok: (d.subject ?? "").length > 0 && (d.subject ?? "").length <= 60, title: t("Subject under 60 characters", "主旨少於 60 字") },
    { ok: Boolean(d.preheader), title: t("Preheader is filled", "已填寫預覽文字"), why: t("One supporting line can lift open rate.", "一行補充文字可提高開啟率。") },
    { ok: d.sections.some((s) => s.type === "body" && s.body), title: t("The message has body copy", "訊息包含內容") },
    { ok: d.sections.some((s) => s.type === "cta" && s.cta_url), title: t("A working call-to-action button", "設有可用的呼籲按鈕"), why: t("Give readers a clear next step.", "為讀者提供明確的下一步。") }
  ];
  const nBlocked = blocking.filter((b) => !b.ok).length;
  const sendable = !miss.length && !locked && !stale && !(e && !e.eligible) && capOk("favcrm_connector") && capOk("email_sender") && !dirty();
  return `<div class="cols">
    <div class="stack">
      <section class="card">
        <div class="card-head"><h3>${t("Send summary", "發送摘要")}</h3><span class="meta">${t("Draft revision", "草稿修訂版本")} #${c?.revision ?? 0}</span></div>
        <div class="card-body"><dl class="dl">
          ${dlRow(t("Audience", "受眾"), esc(capOk("favcrm_connector") ? sourceLabel(d) : t("Unresolved — no CRM", "未解析 — 無 CRM")))}
          ${dlRow(t("Eligible", "符合資格"), capOk("favcrm_connector") && e && !stale ? number(e.eligible ?? 0) : "—")}
          ${dlRow(t("Exclusions", "排除名單"), number(d.audience_exclusions.length))}
          ${dlRow(t("Subject", "主旨"), esc(d.subject || "—"))}
          ${dlRow(t("Content blocks", "內容區塊"), number(d.sections.length))}
          ${dlRow(t("Email sender", "電郵寄件者"), capOk("email_sender") && S.sender?.from_email ? esc(S.sender.from_email) : senderUnknown ? `<span class="danger-text">${esc(t(`Could not check — ${S.senderError}`, `無法檢查——${S.senderError}`))}</span>` : `<span class="danger-text">${t("Not set", "尚未設定")}</span>`)}
        </dl></div>
      </section>

      <section class="card card--blocking">
        <div class="card-head">
          <div><h3>${t("Required before send", "發送前必須完成")}</h3><p class="meta">${t("All must be done before anything can send.", "全部完成後才可發送。")}</p></div>
          ${badge(String(nBlocked), nBlocked ? "danger" : "success")}
        </div>
        <div class="card-body"><div class="checks">
          ${blocking.map((b) => checkRow(b.ok ? "ok" : "block", b.title, { why: b.ok ? "" : b.why, fix: b.ok ? "" : b.fix, action: b.action, value: b.value })).join("")}
        </div></div>
      </section>

      <section class="card card--advisory">
        <div class="card-head"><div><h3>${t("Pre-send checks", "發送前檢查")}</h3><p class="meta">${t("Suggestions, not requirements — your call.", "建議事項，並非強制 — 由您決定。")}</p></div></div>
        <div class="card-body"><div class="checks">
          ${tips.map((tip) => checkRow(tip.ok ? "ok" : "tip", tip.title, { why: tip.ok ? "" : tip.why })).join("")}
        </div></div>
      </section>
    </div>

    <aside class="rail">
      <section class="card">
        <div class="card-head"><h3>${t("Send a test first", "先寄一封測試")}</h3></div>
        <div class="card-body">
          <p class="field-hint">${t("Goes to you or a colleague — never to customers.", "寄給自己或同事 — 不會寄給客戶。")}</p>
          <input class="field-control" type="email" data-field="testTo" data-key="test-to" value="${esc(S.testTo)}" placeholder="you@example.com" ${locked ? "disabled" : ""}>
          <div class="step-actions">${button("test", S.busy === "test" ? t("Sending…", "發送中…") : t("Send test", "發送測試"), { kind: "secondary", ic: "send", key: "test", disabled: locked || busy() || !S.testTo.trim() || !capOk("email_sender") || !capOk("favcrm_connector") })}</div>
          ${S.testSent ? `<p class="field-hint ok-text">${esc(t(`Test email sent to ${S.testSent}.`, `測試電郵已寄至 ${S.testSent}。`))}</p>` : ""}
        </div>
      </section>

      <section class="send-panel">
        <div class="card-head"><h3>${t("Send timing", "發送時間")}</h3></div>
        <div class="card-body">
          <div class="choice-list" role="radiogroup" aria-label="${t("Send timing", "發送時間")}">
            <label class="choice"><input type="radio" name="timing" data-field="timing" value="now"${!isScheduled ? " checked" : ""}${locked ? " disabled" : ""}><span class="choice-title">${t("Send on approval", "審批後立即發送")}</span></label>
            <label class="choice"><input type="radio" name="timing" data-field="timing" value="later"${isScheduled ? " checked" : ""}${locked || !capOk("schedule") ? " disabled" : ""}><span class="choice-title">${t("Schedule for later", "排程稍後發送")}</span></label>
          </div>
          ${isScheduled ? `<div class="sub-field"><label class="field-label" for="sched">${t("Schedule for later", "排程稍後發送")}</label><input id="sched" class="field-control" type="datetime-local" data-field="schedule" data-key="sched" value="${esc(d.scheduled_for)}" ${locked || !capOk("schedule") ? "disabled" : ""}></div>` : ""}
          ${!capOk("schedule") ? `<p class="meta">${t("Scheduling is a door this workspace has not granted — sends stay on approval only.", "此工作區尚未授予排程功能——發送僅限核准後立即執行。")}</p>` : ""}
          <div class="step-actions">${button("review-send", isScheduled ? t("Approve & schedule", "核准並排程") : t("Approve & send", "審批並發送"), { kind: "primary", ic: "check", key: "send", disabled: !sendable })}</div>
          ${sendable ? "" : `<p class="blocked">${icon("alert")}<span>${esc(dirty() ? t("Save first — approval binds a saved revision, not your open edits.", "請先儲存——核准綁定已儲存的版本，而非未儲存的修改。") : t(`${nBlocked} required item${nBlocked === 1 ? "" : "s"} still outstanding.`, `仍有 ${nBlocked} 項必須完成的項目。`))}</span></p>`}
        </div>
      </section>
    </aside>
  </div>`;
}

// ------------------------------------------------------------- sent screen

function sentView() {
  const c = S.campaign;
  const stats = c?.outcome?.delivery_stats ?? c?.stats ?? null;
  const sentAt = c?.outcome?.sent_at ?? c?.updatedAt;
  const undoLeft = c?.outcome?.undo_until ? Math.max(0, Math.round((new Date(c.outcome.undo_until).getTime() - Date.now()) / 1000)) : 0;
  return `${editorHead()}
  ${stepper(2)}
  <div class="cols">
    <div class="stack">
      <section class="card card--sent"><div class="card-body sent-body">
        <span class="sent-check">${icon("check")}</span>
        <div class="grow">
          <h2 class="sent-title">${t("Sent", "已發送")}</h2>
          <p class="field-hint">${esc(t(`On its way to ${stats?.sent ?? recipientsOf(c)} recipients. Delivery numbers update shortly.`, `正在寄給 ${stats?.sent ?? recipientsOf(c)} 位收件者。送達數字會在稍後更新。`))}</p>
          ${undoLeft > 0 ? `<div class="undo-row">${button("undo", t("Undo send", "撤回發送"), { kind: "danger", key: "undo-sent", disabled: busy() })}<span class="meta undo-left">${icon("clock")}${esc(t(`${undoLeft}s left`, `尚餘 ${undoLeft} 秒`))}</span></div>` : ""}
        </div>
      </div></section>
      ${stats ? `<section class="card"><div class="card-head"><h3>${t("Delivery", "發送情況")}</h3></div>
        <div class="card-body"><dl class="dl">
          ${stats.sent != null ? dlRow(t("Sent", "已寄出"), number(stats.sent)) : ""}
          ${stats.delivered != null ? dlRow(t("Delivered", "已送達"), number(stats.delivered)) : ""}
          ${stats.failed ? dlRow(t("Failed", "失敗"), `<span class="danger-text">${number(stats.failed)}</span>`) : ""}
          ${stats.bounced ? dlRow(t("Bounced", "退信"), `<span class="danger-text">${number(stats.bounced)}</span>`) : ""}
        </dl></div></section>` : ""}
      <div>${button("list", t("Back to campaigns", "返回活動列表"), { kind: "quiet", ic: "back", key: "sent-back" })}</div>
    </div>
    <aside class="rail">${previewPane()}</aside>
  </div>`;
}

function editorView() {
  if (S.campaign?.status === "sent") return `<div class="gadget">${sentView()}</div>`;
  const steps = [audienceStep, contentStep, reviewStep];
  const last = S.step === 2;
  return `<div class="gadget">${editorHead()}
  ${notices()}
  ${proposalsStrip()}
  ${stepper(S.step)}
  ${steps[S.step]()}
  <div class="step-actions">
    ${button(last ? "list" : "next-step", last ? t("Back to campaigns", "返回活動列表") : t("Continue", "繼續"), { kind: last ? "quiet" : "primary", ic: last ? "back" : "chev", key: "next" })}
    ${S.step > 0 ? button("prev-step", t("Back", "返回"), { kind: "quiet", key: "prev" }) : ""}
  </div></div>`;
}

// ------------------------------------------------------------- setup view

function setupView() {
  const row = (key, ic, title, body, action, label) =>
    `<div class="check check--${capOk(key) ? "ok" : "block"}"><span class="check-mark">${icon(capOk(key) ? "check" : ic)}</span><div class="check-body"><div class="check-title">${title}</div><div class="check-why">${body}</div></div>${capOk(key) ? badge(t("Granted", "已授權"), "success") : button(action, label, { kind: "secondary", key: "setup-" + action })}</div>`;
  return `<div class="gadget">${pageHead({
    title: t("Set up Email Campaigns", "設定電郵活動"),
    sub: t("These capabilities connect this bot to your workspace. You can grant them now or later — drafting works either way; only sending waits on them.", "連接這些功能即可使用此機械人。您可以現在或稍後授權——草擬不受影響，只有傳送需要授權。")
  })}
  ${S.capabilitiesError ? `<div class="strip"><span class="strip-icon warn">${icon("alert")}</span><span class="strip-text">${esc(t(`Capabilities could not be checked — ${S.capabilitiesError}`, `無法檢查功能授權——${S.capabilitiesError}`))}</span></div>` : ""}
  <section class="card"><div class="card-body"><div class="checks">
    ${row("favcrm_connector", "users", t("FavCRM connector", "FavCRM 連接"), t("Reads segments and customers, and hands delivery to FavCRM's queue — consent and unsubscribe stay with it.", "讀取客戶群組及客戶資料，並交由 FavCRM 佇列傳送——同意狀態及取消訂閱均由其管理。"), "grant-favcrm", t("Connect FavCRM", "連接 FavCRM"))}
    ${row("email_sender", "mail", t("Sender identity", "寄件者身分"), t("The verified address campaigns are sent from, via your email provider.", "活動使用的已驗證寄件地址，經您的電郵服務商發出。"), "sender", t("Set up sender", "設定寄件者"))}
    ${row("workspace", "bell", t("Workspace notifications", "工作區通知"), t("Tells you when a send finishes, fails, or needs a decision. Optional.", "傳送完成、失敗或需要您決定時通知您。可選。"), "grant-workspace", t("Allow notifications", "允許通知"))}
  </div></div></section>
  <div class="step-actions">${button("enter", t("Continue to campaigns", "前往活動列表"), { kind: "primary", key: "enter" })}</div></div>`;
}

// ----------------------------------------------------- loading / error

function loadingView() {
  return `<div class="gadget">${pageHead({
    title: t("Campaigns", "推廣活動"),
    sub: t("Send bulk email to your customers — drafted, reviewed and sent through the connected CRM.", "向客戶發送批量電郵 — 經由已連接的 CRM 草擬、審閱及發送。"),
    actions: `<div class="skeleton sk-btn"></div>`
  })}
  <div class="sk-stack" aria-hidden="true">
    <div class="skeleton" style="height:42px;width:min(320px,100%)"></div>
    <div class="skeleton" style="height:36px"></div>
    <div class="skeleton" style="height:54px"></div>
    <div class="skeleton" style="height:54px"></div>
    <div class="skeleton" style="height:54px"></div>
  </div>
  <p class="meta load-line" role="status">${t("Loading…", "載入中…")}</p></div>`;
}

function errorView() {
  return `<div class="gadget">${pageHead({
    title: t("Campaigns", "推廣活動"),
    sub: t("Send bulk email to your customers — drafted, reviewed and sent through the connected CRM.", "向客戶發送批量電郵 — 經由已連接的 CRM 草擬、審閱及發送。"),
    actions: `<div class="skeleton sk-btn"></div>`
  })}
  <div class="sk-stack" aria-hidden="true">
    <div class="skeleton" style="height:42px;width:min(320px,100%)"></div>
    <div class="skeleton" style="height:36px"></div>
    <div class="skeleton" style="height:54px"></div>
    <div class="skeleton" style="height:54px"></div>
    <div class="skeleton" style="height:54px"></div>
  </div>
  <div class="strip strip--danger" role="alert"><span class="strip-icon">${icon("alert")}</span>
    <span class="strip-text"><strong>${t("Could not load campaigns.", "未能載入推廣活動。")}</strong><br>
      <span class="refusal">${esc(S.loadError || t("The response was lost — retry, or check back shortly.", "回應遺失。請重試，或稍後再檢查。"))}</span></span>
    ${button("retry", t("Retry", "重試"), { kind: "secondary", ic: "refresh", key: "retry" })}
  </div></div>`;
}

// ------------------------------------------------------------------- root

export function gadgetApp() {
  if (S.loading) return loadingView();
  if (S.loadError) return errorView();
  if (S.view === "new") return newView();
  if (S.view === "editor" && S.campaign) return editorView();
  if (S.view === "setup") return setupView();
  return listView();
}

// ------------------------------------------------------------------ dialogs

export function openGrant(key = S.grantKey) {
  S.grantKey = key;
  const names = {
    favcrm_connector: ["FavCRM connector", "FavCRM 連接", "Members, segments and estimates come through it. Granting lets the gadget read audience data — it cannot send anything.", "會員、分群與估算都經由此連接器取得。授權後小工具可讀取受眾資料，但不可發送任何內容。"],
    email_sender: ["Email sender", "電郵寄件者", "Sending and tests go through it. Without it the gadget drafts but never sends.", "發送及測試都經由此連接。未取得授權前，小工具只能建立草稿。"],
    schedule: ["Schedule", "排程", "Lets the gadget register a future send time with the platform.", "允許小工具向平台登記日後的發送時間。"],
    workspace: ["Workspace", "工作區", "Read-only access to workspace metadata — names, not content.", "對工作區元數據的唯讀存取 — 只限名稱。"]
  };
  const [en, zh, enBody, zhBody] = names[key] ?? [key, key, "", ""];
  dialogShell(
    t(`Grant ${en}`, `授權${zh}`),
    t("The platform owns this grant — the gadget only sees the outcome.", "授權由平台管理，小工具只會得知結果。"),
    `<p>${esc(t(enBody, zhBody))}</p>`,
    `${button("deny", t("Cancel", "取消"), { kind: "quiet", key: "grant-deny" })}${button("grant", t("Grant access", "授權"), { kind: "primary", key: "grant-ok" })}`
  );
}

export function openSender() {
  dialogShell(
    t("Set up sender", "設定寄件者"),
    t("Verification happens with the provider — the gadget stores the outcome, not credentials.", "驗證在服務商一方完成，小工具只保存結果，不保存憑證。"),
    `${field("sender-name", t("From name", "寄件者名稱"), S.sender?.from_name ?? "", { placeholder: t("Essential Foods HK", "九龍工作室會員組") })}
     ${field("sender-from", t("From address", "寄件地址"), S.sender?.from_email ?? "", { type: "email", placeholder: "hello@example.com" })}
     <div class="field"><label class="field-label" for="provider">${t("Provider", "服務供應商")}</label><select id="provider" class="select-control" data-field="provider" data-key="provider">${[["resend", "Resend"], ["ses", "Amazon SES"], ["smtp", "SMTP"]].map(([v, l]) => `<option value="${v}"${S.provider === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>`,
    `${button("close-dialog", t("Cancel", "取消"), { kind: "quiet", key: "sender-cancel" })}${button("connect-sender", t("Verify & save", "驗證並儲存"), { kind: "primary", ic: "check", key: "sender-ok" })}`
  );
}

export function openProposal() {
  const p = (S.proposals ?? []).filter((x) => x.status === "open" || x.state === "pending").at(-1) ?? S.proposals?.[0];
  if (!p) return;
  dialogShell(
    t("Assistant proposal", "助理建議"),
    t(`Base revision ${p.base_revision ?? "—"}`, `基礎修訂版本 ${p.base_revision ?? "—"}`),
    `<p>${esc(p.rationale || t("Changes pending review", "變更待檢閱"))}</p><p class="field-hint">${esc(t("Accepting applies the assistant's changes on top of your saved draft. Rejecting discards them.", "接受會將助理的變更套用於已儲存的草稿；拒絕則捨棄變更。"))}</p>`,
    `${button("dismiss-proposal", t("Reject", "拒絕"), { kind: "quiet", key: "prop-no" })}${button("accept-proposal", t("Accept", "接受"), { kind: "primary", key: "prop-yes" })}`
  );
}

export function openConfirm() {
  const isScheduled = Boolean(S.edit?.scheduled_for);
  const d = S.edit ?? {};
  dialogShell(
    isScheduled ? t("Approve & schedule", "核准並排程") : t("Approve & send", "審批並發送"),
    t("Approval binds this exact revision — any later edit needs a fresh approval.", "核准將綁定此版本——其後修改需重新核准。"),
    `<dl class="dl">
      ${dlRow(t("Subject", "主旨"), esc(d.subject || "—"))}
      ${dlRow(t("Audience", "受眾"), esc(capOk("favcrm_connector") ? sourceLabel(d) : t("Unresolved — no CRM", "未解析 — 無 CRM")))}
      ${dlRow(t("Timing", "時間"), isScheduled ? esc(formatSchedule(d.scheduled_for)) : t("On approval", "核准後"))}
    </dl>`,
    `${button("close-dialog", t("Cancel", "取消"), { kind: "quiet", key: "send-cancel" })}${button("confirm-send", isScheduled ? t("Approve & schedule", "核准並排程") : t("Approve & send", "審批並發送"), { kind: "primary", ic: "check", key: "send-ok" })}`
  );
}

export function openConflict() {
  dialogShell(
    t("Resolve conflict", "處理衝突"),
    t("The stored draft was edited elsewhere. Choose whose version becomes the working copy.", "此草稿曾於其他地方修改。請選擇以哪個版本作為編輯基礎。"),
    `<label class="choice"><input type="radio" name="conflict" data-field="conflictChoice" value="mine"${S.conflictChoice === "mine" ? " checked" : ""}><span class="choice-title">${t("Keep mine — overwrite the stored draft", "保留我的版本 — 覆寫已儲存的草稿")}</span></label>
     <label class="choice"><input type="radio" name="conflict" data-field="conflictChoice" value="theirs"${S.conflictChoice === "theirs" ? " checked" : ""}><span class="choice-title">${t("Take theirs — discard my edits", "採用對方版本 — 捨棄我的修改")}</span></label>`,
    `${button("close-dialog", t("Cancel", "取消"), { kind: "quiet", key: "conflict-cancel" })}${button("resolve-conflict", t("Apply", "套用"), { kind: "primary", key: "conflict-ok" })}`
  );
}

export function openScheduleManage() {
  const c = S.campaign;
  dialogShell(
    t("Manage schedule", "管理排程"),
    t(`Currently scheduled for ${formatSchedule(c?.draft?.scheduled_for)}`, `現排程於 ${formatSchedule(c?.draft?.scheduled_for)}`),
    `${field("reschedule", t("New send time", "新發送時間"), c?.draft?.scheduled_for ?? "", { type: "datetime-local" })}`,
    `${button("unschedule", t("Unschedule", "取消排程"), { kind: "quiet", key: "unsched" })}${button("reschedule", t("Reschedule", "更改時間"), { kind: "primary", key: "resched" })}`
  );
}
