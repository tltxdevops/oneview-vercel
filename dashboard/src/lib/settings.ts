const THEME_KEY = "oneview_theme";
const REFRESH_KEY = "oneview_refresh_interval";

export type Theme = "light" | "dark";

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark") return "dark";
  } catch {}
  return "light";
}

export function setStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function getStoredRefreshInterval(): number {
  try {
    const v = localStorage.getItem(REFRESH_KEY);
    if (v) {
      const n = Number(v);
      if (!Number.isNaN(n) && n > 0) return Math.max(5, Math.floor(n));
    }
  } catch {}
  return 60;
}

export function setStoredRefreshInterval(seconds: number) {
  try {
    localStorage.setItem(REFRESH_KEY, String(Math.max(5, Math.floor(seconds))));
  } catch {}
}

// Initialize theme on import
if (typeof window !== "undefined") {
  setStoredTheme(getStoredTheme());
}

export default {
  getStoredTheme,
  setStoredTheme,
  getStoredRefreshInterval,
  setStoredRefreshInterval,
};
