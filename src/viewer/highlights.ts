/**
 * User-drawn text highlights. Persists rectangles as fractional coords
 * (0..1) relative to each PDF page so they stay aligned across zoom levels.
 */

export interface HighlightRect {
  pageIndex: number; // 0-based
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  color: string;
  rects: HighlightRect[];
}

export class HighlightStore {
  constructor(private pdfUrl: string) {}

  private key(): string {
    return `vimdf:highlights:${this.pdfUrl}`;
  }

  async load(): Promise<Highlight[]> {
    if (!this.pdfUrl) return [];
    const r = await chrome.storage.local.get(this.key());
    return (r[this.key()] ?? []) as Highlight[];
  }

  async save(list: Highlight[]): Promise<void> {
    if (!this.pdfUrl) return;
    await chrome.storage.local.set({ [this.key()]: list });
  }
}

/**
 * (Re)render the highlight overlay on a single page. Removes any prior
 * overlay layer for the page, then lays out all matching rects.
 */
export function renderHighlightsForPage(
  pageEl: HTMLElement,
  pageIdx: number,
  highlights: Highlight[],
  onDelete: (id: string) => void,
): void {
  pageEl.querySelector(".user-hl-layer")?.remove();

  const layer = document.createElement("div");
  layer.className = "user-hl-layer";

  for (const h of highlights) {
    for (const r of h.rects) {
      if (r.pageIndex !== pageIdx) continue;
      const box = document.createElement("div");
      box.className = "user-hl";
      box.style.background = h.color;
      box.style.left = `${r.x * 100}%`;
      box.style.top = `${r.y * 100}%`;
      box.style.width = `${r.w * 100}%`;
      box.style.height = `${r.h * 100}%`;
      box.dataset.hlId = h.id;
      box.title = "Right-click to remove";
      box.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        onDelete(h.id);
      });
      layer.appendChild(box);
    }
  }
  pageEl.appendChild(layer);
}
