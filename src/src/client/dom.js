// Email Campaign client — tiny DOM helpers shared by every view module.
//
// The accepted preview renders with HTML-string templates; this module is the
// escaping boundary that makes that safe. Every untrusted value (a draft
// field, an audience label, a proposal title) goes through `esc()` at the
// render site — never raw. There is no exception: no markup reaches this
// document unescaped.

import { t } from "./i18n.js";

export const $ = (q, root = document) => root.querySelector(q);

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Studio's icon vocabulary on the 24 grid — the same names the preview drew.
const paths = {
  mail: "M3 5h18v14H3z M3 6l9 7 9-7",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  chart: "M4 20V10 M10 20V4 M16 20v-7 M22 20V7",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h6",
  calendar: "M4 5h16v16H4z M16 3v4 M8 3v4 M4 11h16",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
  chev: "M9 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  back: "M19 12H5 M11 6l-6 6 6 6",
  plus: "M12 5v14 M5 12h14",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  check: "M4 12l5 5L20 6",
  close: "M6 6l12 12 M18 6L6 18",
  clock: "M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  shield: "M12 3l8 4v6c0 5-8 9-8 9s-8-4-8-9V7z M8 12l3 3 5-6",
  info: "M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  spark: "M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  monitor: "M3 3h18v14H3z M8 21h8 M12 17v4",
  phone: "M7 2h10v20H7z M11 18h2",
  text: "M4 5h16 M4 10h16 M4 15h16 M4 20h10",
  heading: "M5 4v16 M19 4v16 M5 12h14",
  image: "M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M8 7h.01",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  up: "M6 15l6-6 6 6",
  trash: "M3 6h18 M8 6V3h8v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
  refresh: "M20 7a9 9 0 1 0 1 9 M20 3v5h-5",
  send: "M22 2L9 15 M22 2l-7 20-6-7-7-6z",
  undo: "M9 5L4 10l5 5 M4 10h10a6 6 0 0 1 0 12",
  plug: "M9 2v6 M15 2v6 M7 8h10v4a5 5 0 0 1-10 0z M12 17v5",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9 M13.7 21a2 2 0 0 1-3.4 0",
  door: "M15 3h4v18h-4 M10 17l5-5-5-5 M15 12H3",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8 M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  code: "M8 6l-6 6 6 6 M16 6l6 6-6 6"
};

export const icon = (n, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[n] || paths.mail}"/></svg>`;

/** A stable-labelled button — the label keeps its width while the text swaps to a busy state. */
export function button(action, label, { kind = "", ic = "", key = action, disabled = false, extra = "" } = {}) {
  const stable = {
    save: t("Save draft", "儲存草稿"),
    estimate: t("Refresh estimate", "更新預估"),
    "connect-sender": t("Verify & save", "驗證並儲存"),
    recheck: t("Check status", "檢查狀態"),
    "confirm-send": t("Approve & send", "核准並傳送")
  };
  const text = stable[action]
    ? `<span class="busy-label"><span class="measure" aria-hidden="true">${stable[action]}</span><span>${label}</span></span>`
    : `<span>${label}</span>`;
  return `<button type="button" class="btn ${kind}" data-action="${action}" data-key="${esc(key)}" ${disabled ? 'aria-disabled="true"' : ""} ${extra}>${ic ? icon(ic) : ""}${text}</button>`;
}

export function field(key, label, value, { type = "text", hint = "", placeholder = "", disabled = false } = {}) {
  return `<div class="field"><label for="${key}">${label}</label><input id="${key}" data-field="${key}" data-key="${key}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${disabled ? "disabled" : ""}>${hint ? `<p id="${key}-hint" class="hint">${hint}</p>` : ""}</div>`;
}

export function notice(title, body = "", kind = "", action = "") {
  return `<div class="notice ${kind}" role="${kind === "error" ? "alert" : "status"}">${icon(kind === "success" ? "check" : "info")}<div class="grow"><strong>${title}</strong>${body ? `<p>${body}</p>` : ""}</div>${action ? `<div class="notice-actions">${action}</div>` : ""}</div>`;
}

export function announce(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => el.classList.remove("show"), 3500);
}

/**
 * Re-render without losing the focused control, its text selection, or the
 * scroll position — the preview's render contract, kept verbatim.
 */
export function preserveRender(root, html) {
  const active = document.activeElement;
  const key = active?.dataset?.key;
  let selection = null;
  try {
    if (active?.selectionStart != null) selection = [active.selectionStart, active.selectionEnd];
  } catch {}
  const cv = root.querySelector(".canvas") ?? root;
  const sc = cv.scrollTop ?? 0;
  root.innerHTML = html;
  const ncv = root.querySelector(".canvas") ?? root;
  ncv.scrollTop = sc;
  if (key) {
    const target = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      if (selection) try { target.setSelectionRange(...selection); } catch {}
    }
  }
}

export function showDialog(html, drawer = false) {
  const dlg = $("#dialog");
  if (!dlg) return;
  dlg.className = drawer ? "drawer" : "";
  dlg.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  const first = dlg.querySelector("[data-autofocus]") || dlg.querySelector("button,input,select,textarea");
  first?.focus();
}

export function closeDialog() {
  const dlg = $("#dialog");
  if (dlg?.open) dlg.close();
  if (dlg) dlg.innerHTML = "";
}

export function dialogShell(title, desc, body, foot, drawer = false) {
  showDialog(
    `<div class="dialog-head"><div class="grow"><h2 id="dialog-title">${title}</h2>${desc ? `<p>${desc}</p>` : ""}</div><button class="btn quiet icon" data-action="close-dialog" data-key="dlg-close" aria-label="${t("Close", "關閉")}">${icon("close")}</button></div><div class="dialog-body">${body}</div>${foot ? `<div class="dialog-footer">${foot}</div>` : ""}`,
    drawer
  );
}
