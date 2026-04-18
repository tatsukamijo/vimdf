import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  saveSettings,
  type Settings,
  type Theme,
} from "../common/settings";

const fields = {
  theme: document.getElementById("theme") as HTMLSelectElement,
  scrollStep: document.getElementById("scrollStep") as HTMLInputElement,
  hScrollStep: document.getElementById("hScrollStep") as HTMLInputElement,
  zoomStep: document.getElementById("zoomStep") as HTMLInputElement,
  rememberLastPage: document.getElementById(
    "rememberLastPage",
  ) as HTMLInputElement,
  halfPageDownKey: document.getElementById(
    "halfPageDownKey",
  ) as HTMLInputElement,
  halfPageUpKey: document.getElementById(
    "halfPageUpKey",
  ) as HTMLInputElement,
  fullPageDownKey: document.getElementById(
    "fullPageDownKey",
  ) as HTMLInputElement,
  fullPageUpKey: document.getElementById(
    "fullPageUpKey",
  ) as HTMLInputElement,
  hintBg: document.getElementById("hintBg") as HTMLInputElement,
  hintFg: document.getElementById("hintFg") as HTMLInputElement,
  hintMatchedFg: document.getElementById("hintMatchedFg") as HTMLInputElement,
  statusBarBg: document.getElementById("statusBarBg") as HTMLInputElement,
  statusBarFg: document.getElementById("statusBarFg") as HTMLInputElement,
  statusBarFontSize: document.getElementById(
    "statusBarFontSize",
  ) as HTMLInputElement,
};

const colorFields: Array<{ el: HTMLInputElement; fallback: string }> = [
  { el: fields.hintBg, fallback: "#323232" },
  { el: fields.hintFg, fallback: "#f5f5f5" },
  { el: fields.hintMatchedFg, fallback: "#f97316" },
  { el: fields.statusBarBg, fallback: "#252525" },
  { el: fields.statusBarFg, fallback: "#c0c0c0" },
];

const keyInputs = [
  fields.halfPageDownKey,
  fields.halfPageUpKey,
  fields.fullPageDownKey,
  fields.fullPageUpKey,
];

function displayKey(raw: string): string {
  if (!raw) return "";
  const parts = raw.split("+");
  const last = parts[parts.length - 1];
  const pretty = last === " " ? "Space" : last;
  return [...parts.slice(0, -1), pretty].join("+");
}

function serializeKey(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null; // modifier-only press, wait for the actual key
  }
  if (key.length !== 1) return null; // ignore function / arrow keys
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

function setupKeycapInput(el: HTMLInputElement): void {
  el.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (e.key === "Backspace" || e.key === "Delete" || e.key === "Escape") {
      el.dataset.raw = "";
      el.value = "";
      void onFieldChange();
      return;
    }
    const raw = serializeKey(e);
    if (raw === null) return;
    el.dataset.raw = raw;
    el.value = displayKey(raw);
    void onFieldChange();
  });
}

keyInputs.forEach(setupKeycapInput);

const status = document.getElementById("status")!;
const resetBtn = document.getElementById("reset") as HTMLButtonElement;

let statusTimer: number | undefined;

function flashStatus(msg: string): void {
  status.textContent = msg;
  status.classList.add("saved");
  if (statusTimer !== undefined) window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    status.classList.remove("saved");
    status.textContent = "";
  }, 1200);
}

function apply(settings: Settings): void {
  fields.theme.value = settings.theme;
  fields.scrollStep.value = String(settings.scrollStep);
  fields.hScrollStep.value = String(settings.hScrollStep);
  fields.zoomStep.value = String(settings.zoomStep);
  fields.rememberLastPage.checked = settings.rememberLastPage;
  applyKey(fields.halfPageDownKey, settings.halfPageDownKey);
  applyKey(fields.halfPageUpKey, settings.halfPageUpKey);
  applyKey(fields.fullPageDownKey, settings.fullPageDownKey);
  applyKey(fields.fullPageUpKey, settings.fullPageUpKey);
  applyColor(fields.hintBg, settings.hintBg, "#323232");
  applyColor(fields.hintFg, settings.hintFg, "#f5f5f5");
  applyColor(fields.hintMatchedFg, settings.hintMatchedFg, "#f97316");
  applyColor(fields.statusBarBg, settings.statusBarBg, "#252525");
  applyColor(fields.statusBarFg, settings.statusBarFg, "#c0c0c0");
  fields.statusBarFontSize.value = String(settings.statusBarFontSize);
}

function applyKey(el: HTMLInputElement, raw: string): void {
  el.dataset.raw = raw;
  el.value = displayKey(raw);
}

function applyColor(el: HTMLInputElement, raw: string, fallback: string): void {
  el.dataset.raw = raw;
  el.value = raw || fallback;
  el.classList.toggle("is-default", !raw);
  const hex = document.querySelector<HTMLInputElement>(
    `input.hex[data-target="${el.id}"]`,
  );
  if (hex) {
    hex.value = raw;
    hex.classList.remove("invalid");
  }
}

function normalizeHex(s: string): string | null {
  const t = s.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(t)) return `#${t}`;
  if (/^[0-9a-f]{3}$/.test(t)) {
    return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`;
  }
  return null;
}

function readForm(): Partial<Settings> {
  return {
    theme: fields.theme.value as Theme,
    scrollStep: clamp(parseInt(fields.scrollStep.value, 10), 10, 500, 100),
    hScrollStep: clamp(parseInt(fields.hScrollStep.value, 10), 10, 500, 80),
    zoomStep: clamp(parseFloat(fields.zoomStep.value), 1.01, 2, 1.1),
    rememberLastPage: fields.rememberLastPage.checked,
    halfPageDownKey: fields.halfPageDownKey.dataset.raw ?? "",
    halfPageUpKey: fields.halfPageUpKey.dataset.raw ?? "",
    fullPageDownKey: fields.fullPageDownKey.dataset.raw ?? "",
    fullPageUpKey: fields.fullPageUpKey.dataset.raw ?? "",
    hintBg: fields.hintBg.dataset.raw ?? "",
    hintFg: fields.hintFg.dataset.raw ?? "",
    hintMatchedFg: fields.hintMatchedFg.dataset.raw ?? "",
    statusBarBg: fields.statusBarBg.dataset.raw ?? "",
    statusBarFg: fields.statusBarFg.dataset.raw ?? "",
    statusBarFontSize: clamp(
      parseInt(fields.statusBarFontSize.value, 10),
      9,
      24,
      12,
    ),
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function onFieldChange(): Promise<void> {
  await saveSettings(readForm());
  flashStatus("Saved");
}

for (const el of Object.values(fields)) {
  // keycap inputs commit on their own keydown handler; skip "change" for them.
  if (el.classList.contains("keycap")) continue;
  el.addEventListener("change", () => {
    if (el.type === "color") {
      el.dataset.raw = el.value;
      el.classList.remove("is-default");
    }
    void onFieldChange();
  });
}

document.querySelectorAll<HTMLInputElement>("input.hex").forEach((hex) => {
  const targetId = hex.dataset.target;
  if (!targetId) return;
  const entry = colorFields.find((c) => c.el.id === targetId);
  if (!entry) return;
  const commit = (): void => {
    const raw = hex.value.trim();
    if (raw === "") {
      applyColor(entry.el, "", entry.fallback);
      void onFieldChange();
      return;
    }
    const normalized = normalizeHex(raw);
    if (normalized === null) {
      hex.classList.add("invalid");
      return;
    }
    hex.classList.remove("invalid");
    applyColor(entry.el, normalized, entry.fallback);
    void onFieldChange();
  };
  hex.addEventListener("change", commit);
  hex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  });
});

document.querySelectorAll<HTMLButtonElement>("button.clear").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    if (!targetId) return;
    const entry = colorFields.find((c) => c.el.id === targetId);
    if (!entry) return;
    applyColor(entry.el, "", entry.fallback);
    void onFieldChange();
  });
});

resetBtn.addEventListener("click", async () => {
  await resetSettings();
  apply(DEFAULT_SETTINGS);
  flashStatus("Reset to defaults");
});

void loadSettings().then(apply);
