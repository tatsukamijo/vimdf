/**
 * User-configurable settings. Stored in chrome.storage.sync so they ride along
 * with the user's Chrome profile across devices.
 */

export type Theme = "dark" | "light" | "auto";

export interface Settings {
  theme: Theme;
  scrollStep: number; // px per j/k press
  hScrollStep: number; // px per h/l press
  zoomStep: number; // multiplicative factor per +/- press
  rememberLastPage: boolean;
  // Optional non-modifier aliases for the Ctrl-{d,u,f,b} page-scroll commands.
  // Empty string disables the alias (only the Ctrl version works). Examples:
  //   " "  -> Space triggers half-page down
  //   "d"  -> plain `d` triggers half-page down
  halfPageDownKey: string;
  halfPageUpKey: string;
  fullPageDownKey: string;
  fullPageUpKey: string;
  // Optional color overrides. Empty string = use theme default.
  hintBg: string;
  hintFg: string;
  hintMatchedFg: string;
  statusBarBg: string;
  statusBarFg: string;
  statusBarFontSize: number; // px
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "auto",
  scrollStep: 100,
  hScrollStep: 80,
  zoomStep: 1.1,
  rememberLastPage: true,
  halfPageDownKey: "d",
  halfPageUpKey: "u",
  fullPageDownKey: "",
  fullPageUpKey: "",
  hintBg: "",
  hintFg: "",
  hintMatchedFg: "",
  statusBarBg: "",
  statusBarFg: "",
  statusBarFontSize: 12,
};

export async function loadSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(result as Partial<Settings>) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.sync.set(patch);
}

export async function resetSettings(): Promise<void> {
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (
    _changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ): void => {
    if (area !== "sync") return;
    void loadSettings().then(cb);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Resolve the theme class to apply to <body>. When "auto", follows the
 * browser's color-scheme preference.
 */
export function resolveThemeClass(theme: Theme): "theme-dark" | "theme-light" {
  if (theme === "dark") return "theme-dark";
  if (theme === "light") return "theme-light";
  const prefersLight = window.matchMedia(
    "(prefers-color-scheme: light)",
  ).matches;
  return prefersLight ? "theme-light" : "theme-dark";
}
