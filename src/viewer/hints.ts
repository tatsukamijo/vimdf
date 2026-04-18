/**
 * Vimium-style link hint mode for PDF.js annotation links.
 *
 * On activation:
 *  - Collects all `<a>` elements rendered inside the viewer that intersect
 *    the visible viewport.
 *  - Generates prefix-free labels using a configurable character set.
 *  - Renders badge overlays at each link's top-left corner.
 *  - Intercepts keystrokes until a unique match fires, or the user bails.
 */

import type { Viewer } from "./viewer";

const HINT_CHARS = "sadfjkleincmpgh";

interface Hint {
  link: HTMLAnchorElement;
  label: string;
  overlay: HTMLElement;
}

export class HintController {
  private hints: Hint[] = [];
  private typed = "";
  private active = false;
  private openInNewTab = false;
  private onExit: (() => void) | null = null;
  private onBeforeFollow: ((link: HTMLAnchorElement) => void) | null = null;

  constructor(private viewer: Viewer) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Activate hint mode. Returns false (and does nothing) if no links are
   * visible; caller may want to show feedback in that case.
   */
  activate(opts: {
    newTab?: boolean;
    onExit?: () => void;
    onBeforeFollow?: (link: HTMLAnchorElement) => void;
  } = {}): boolean {
    this.deactivate();
    const links = this.collectVisibleLinks();
    if (links.length === 0) return false;

    const labels = generateLabels(links.length, HINT_CHARS);
    const layer = document.createElement("div");
    layer.id = "hintLayer";

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const label = labels[i];
      const rect = link.getBoundingClientRect();
      const overlay = document.createElement("span");
      overlay.className = "hint";
      overlay.textContent = label;
      overlay.style.top = `${Math.max(0, rect.top - 2)}px`;
      overlay.style.left = `${Math.max(0, rect.left - 2)}px`;
      layer.appendChild(overlay);
      this.hints.push({ link, label, overlay });
    }

    document.body.appendChild(layer);
    this.active = true;
    this.typed = "";
    this.openInNewTab = !!opts.newTab;
    this.onExit = opts.onExit ?? null;
    this.onBeforeFollow = opts.onBeforeFollow ?? null;
    return true;
  }

  handleKey(e: KeyboardEvent): void {
    if (!this.active) return;

    if (e.key === "Escape") {
      e.preventDefault();
      this.deactivate();
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      this.typed = this.typed.slice(0, -1);
      this.refresh();
      return;
    }

    if (e.key.length !== 1) return;

    const ch = e.key.toLowerCase();
    if (!HINT_CHARS.includes(ch)) return;

    e.preventDefault();
    this.typed += ch;

    const matches = this.hints.filter((h) => h.label.startsWith(this.typed));
    if (matches.length === 0) {
      this.deactivate();
      return;
    }
    if (matches.length === 1 && matches[0].label === this.typed) {
      const link = matches[0].link;
      const newTab = this.openInNewTab || e.shiftKey;
      const onBefore = this.onBeforeFollow;
      this.deactivate();
      if (!newTab && onBefore) onBefore(link);
      this.follow(link, newTab);
      return;
    }
    this.refresh();
  }

  deactivate(): void {
    document.getElementById("hintLayer")?.remove();
    this.hints = [];
    this.typed = "";
    if (this.active) {
      this.active = false;
      const cb = this.onExit;
      this.onExit = null;
      this.onBeforeFollow = null;
      cb?.();
    }
  }

  private refresh(): void {
    for (const h of this.hints) {
      if (h.label.startsWith(this.typed)) {
        h.overlay.style.display = "";
        const matched = h.label.slice(0, this.typed.length);
        const rest = h.label.slice(this.typed.length);
        h.overlay.innerHTML = `<span class="matched">${matched}</span>${rest}`;
      } else {
        h.overlay.style.display = "none";
      }
    }
  }

  private collectVisibleLinks(): HTMLAnchorElement[] {
    const containerRect = this.viewer.container.getBoundingClientRect();
    const all =
      this.viewer.viewerEl.querySelectorAll<HTMLAnchorElement>("a[href]");
    const visible: HTMLAnchorElement[] = [];
    for (const a of all) {
      const r = a.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (
        r.bottom <= containerRect.top ||
        r.top >= containerRect.bottom ||
        r.right <= containerRect.left ||
        r.left >= containerRect.right
      ) {
        continue;
      }
      visible.push(a);
    }
    // Top-to-bottom, left-to-right.
    visible.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      if (Math.abs(ra.top - rb.top) > 5) return ra.top - rb.top;
      return ra.left - rb.left;
    });
    return visible;
  }

  private follow(link: HTMLAnchorElement, newTab: boolean): void {
    if (newTab) {
      window.open(link.href, "_blank", "noopener");
      return;
    }
    // PDF.js internal-destination links rely on their own click handler, so
    // fire a synthetic click rather than navigating directly.
    const prevTarget = link.target;
    link.target = "";
    link.click();
    link.target = prevTarget;
  }
}

/**
 * Fixed-length prefix-free label generator.
 * length = ceil(log_c(n)), so e.g. 15 chars in alphabet covers 225 with 2-char.
 */
function generateLabels(n: number, chars: string): string[] {
  if (n === 0) return [];
  const base = chars.length;
  const length = n === 1 ? 1 : Math.ceil(Math.log(n) / Math.log(base));
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    let x = i;
    let label = "";
    for (let j = 0; j < length; j++) {
      label = chars[x % base] + label;
      x = Math.floor(x / base);
    }
    labels.push(label);
  }
  return labels;
}
