// Email Campaign client — interface strings.
//
// English and written Hong Kong Chinese (zh-HK, 書面語) only. No spoken
// Cantonese particle (嘅 咗 唔 呢個 邊個 幾多 睇 喺 嗰) belongs in product
// copy — the client test scans this file for them. Chinese punctuation is
// full-width by convention (。， rather than . ,).
//
// `t(en, zh)` picks by the active locale and is called inline at the render
// site — the same convention the accepted preview uses, so a string and its
// translation stay beside each other rather than drifting apart in a table.

let locale = "en";

export function setLocale(next) {
  locale = next === "zh-HK" || next === "zh" ? "zh" : "en";
}

export function getLocale() {
  return locale;
}

/** `t(english, zhHant)` — the inline pair the render functions call. */
export function t(en, zh) {
  return locale === "zh" ? zh : en;
}

export function number(n) {
  return new Intl.NumberFormat(locale === "zh" ? "zh-HK" : "en-HK").format(n);
}

export function formatSchedule(iso) {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  return dt.toLocaleString(locale === "zh" ? "zh-HK" : "en-HK", { dateStyle: "medium", timeStyle: "short" });
}
