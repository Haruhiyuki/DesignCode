import { ref } from "vue";
import zhCN from "./zh-CN.json";
import en from "./en.json";
import ja from "./ja.json";

const LOCALE_STORAGE_KEY = "designcode.locale";

export const SUPPORTED_LOCALES = [
  { id: "zh-CN", label: "简体中文", nativeLabel: "简体中文" },
  { id: "en", label: "English", nativeLabel: "English" },
  { id: "ja", label: "日本語", nativeLabel: "日本語" }
];

const messages = { "zh-CN": zhCN, en, ja };
const supportedIds = new Set(SUPPORTED_LOCALES.map((l) => l.id));

function detectBrowserLocale() {
  const langs = navigator.languages || [navigator.language || ""];
  for (const lang of langs) {
    const normalized = lang.replace("_", "-");
    if (normalized.startsWith("zh-CN") || normalized.startsWith("zh-Hans")) {
      return "zh-CN";
    }
    if (normalized.startsWith("ja")) {
      return "ja";
    }
    if (normalized.startsWith("en")) {
      return "en";
    }
  }
  return "en";
}

const stored =
  typeof window !== "undefined"
    ? window.localStorage.getItem(LOCALE_STORAGE_KEY)
    : null;
const hasStoredPreference = stored && supportedIds.has(stored);
const initial = hasStoredPreference ? stored : detectBrowserLocale();

export const locale = ref(initial);

if (!hasStoredPreference) {
  document.documentElement.lang = initial;
}

const localeChangeListeners = [];

export function onLocaleChange(fn) {
  localeChangeListeners.push(fn);
}

export function setLocale(id) {
  if (!messages[id]) {
    return;
  }

  locale.value = id;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, id);
  document.documentElement.lang = id;

  for (const fn of localeChangeListeners) {
    try {
      fn(id);
    } catch {}
  }
}

export function t(key, params) {
  const dict = messages[locale.value] || messages["zh-CN"];
  let value = dict[key];

  if (value === undefined) {
    value = messages["zh-CN"][key];
  }

  if (value === undefined) {
    return key;
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, k) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`
    );
  }

  return value;
}
