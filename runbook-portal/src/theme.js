const THEME_KEY = "runbook_theme"; // "light" | "dark" | "system"

export function getStoredThemePref() {
  return localStorage.getItem(THEME_KEY) || "system";
}

function resolveSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function applyTheme(pref) {
  const resolved = pref === "system" ? resolveSystemTheme() : pref;
  document.documentElement.setAttribute("data-theme", resolved);
}

export function setThemePref(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

// Call once at startup — applies immediately (before React renders) to avoid
// a flash of the wrong theme, and keeps following the OS if pref is "system".
export function initTheme() {
  applyTheme(getStoredThemePref());
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (getStoredThemePref() === "system") applyTheme("system");
  });
}
