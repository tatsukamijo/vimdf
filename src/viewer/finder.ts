/**
 * Telescope-style fuzzy finder overlay.
 *
 * Indexes the document's outline, user marks, saved highlights, and full-text
 * (lazily on first open) into a single searchable list. Navigated Vim-style
 * with Ctrl-N/P (or Ctrl-J/K), with a live preview pane showing a thumbnail
 * plus the matching text snippet for the selected entry.
 */

import type { Viewer } from "./viewer";
import type { MarkPosition, MarksStore } from "./marks";
import type { Highlight } from "./highlights";

type EntryKind = "section" | "figure" | "table" | "mark" | "highlight" | "text";

interface Entry {
  kind: EntryKind;
  label: string;
  page: number;
  score: number;
  activate: () => void;
  // fuzzy-matched positions within `label`
  matchIdx?: number[];
  // text-hit snippet info
  snippet?: string;
  // for preview: original page text position of the hit window
  pageHitStart?: number;
  pageHitEnd?: number;
  // for preview: per-char match positions within the page text
  pageMatchPositions?: number[];
  // for figure/table: show the full caption in the preview pane,
  // bolding the "Fig. N" marker prefix.
  previewBody?: string;
  previewBoldEnd?: number;
}

export interface FinderDeps {
  recordJump: () => void;
  getHighlights: () => ReadonlyArray<Highlight>;
  onClose: () => void;
}

const MAX_TEXT_HITS = 400;
const PER_PAGE_HIT_CAP = 25;
const PREVIEW_SCALE = 0.35;

// Regex for figure / table captions — matched against *lines* (text items
// grouped by Y-coordinate), not the whole page. Captions are distinguished
// from body references by structure, not punctuation: a caption begins a
// line, while a body ref appears mid-sentence. Caveat: we anchor at line
// start (`^`), so the separator after the number is irrelevant — `.` / `:`
// / `—` / nothing all work. Authors / styles that don't follow this
// convention (e.g. run-in figure captions inside a paragraph) will miss.
const CAPTION_LINE_RE =
  /^(figure|fig\.?|table|tab\.?)\s+([A-Z]?\d+(?:\.\d+)*[a-z]?|[IVXLC]+)\b/i;

export class Finder {
  private open = false;
  private overlayEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private statusEl!: HTMLElement;

  private entries: Entry[] = [];
  private staticEntries: Entry[] = [];
  private selectedIdx = 0;

  // full-text index
  private pageText: string[] = [];
  // Per-page captions, extracted during indexing. `text` is the full line
  // so the preview pane can show the whole caption; `markerLen` is the
  // length of the "Fig. N" / "Table N" prefix so we can bold it.
  private pageCaptions: Array<
    Array<{
      text: string;
      markerLen: number;
      kindWord: "Figure" | "Table";
      id: string;
    }>
  > = [];
  private textIndexed = false;
  private textIndexing = false;

  // thumbnail cache (page number → canvas)
  private thumbCache = new Map<number, HTMLCanvasElement>();
  private thumbInFlight = new Set<number>();

  // guard async preview renders against rapid selection changes
  private previewToken = 0;

  constructor(
    private viewer: Viewer,
    private marks: MarksStore,
    private deps: FinderDeps,
  ) {
    this.buildDom();
  }

  isActive(): boolean {
    return this.open;
  }

  async show(): Promise<void> {
    if (this.open) return;
    if (!this.viewer.pdfDocument) return;
    this.open = true;
    this.overlayEl.hidden = false;
    this.inputEl.value = "";
    this.buildStaticEntries();
    this.refresh();
    this.inputEl.focus();
    this.inputEl.select();
    if (!this.textIndexed && !this.textIndexing) {
      void this.indexText();
    }
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.overlayEl.hidden = true;
    this.deps.onClose();
  }

  // --- DOM setup ---

  private buildDom(): void {
    const overlay = document.createElement("div");
    overlay.id = "finder";
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="finder-box" role="dialog" aria-label="Finder">
        <div class="finder-header">
          <span class="finder-prompt">&gt;</span>
          <input
            type="text"
            class="finder-input"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search sections, marks, highlights, full text…"
          />
          <span class="finder-status"></span>
        </div>
        <div class="finder-body">
          <div class="finder-list" role="listbox"></div>
          <div class="finder-preview"></div>
        </div>
        <div class="finder-footer">
          <kbd>↵</kbd> open
          <kbd>^N</kbd>/<kbd>^P</kbd> move
          <kbd>^D</kbd>/<kbd>^U</kbd> page
          <kbd>Esc</kbd> close
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlayEl = overlay;
    this.inputEl = overlay.querySelector(".finder-input") as HTMLInputElement;
    this.listEl = overlay.querySelector(".finder-list") as HTMLElement;
    this.previewEl = overlay.querySelector(".finder-preview") as HTMLElement;
    this.statusEl = overlay.querySelector(".finder-status") as HTMLElement;

    this.inputEl.addEventListener("input", () => this.refresh());
    this.inputEl.addEventListener("keydown", (e) => this.handleInputKey(e));

    this.listEl.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".finder-row");
      if (!row) return;
      const idx = Number(row.dataset.idx ?? "-1");
      if (idx < 0 || idx >= this.entries.length) return;
      this.selectedIdx = idx;
      this.activateSelected();
    });
    this.listEl.addEventListener("mousemove", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".finder-row");
      if (!row) return;
      const idx = Number(row.dataset.idx ?? "-1");
      if (idx < 0 || idx === this.selectedIdx) return;
      this.selectedIdx = idx;
      this.applySelection();
    });

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) this.hide();
    });
  }

  // --- key handling (inside the input) ---

  private handleInputKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      this.hide();
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      this.activateSelected();
      return;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      this.move(1);
      return;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const lk = k.toLowerCase();
      if (lk === "n" || lk === "j") {
        e.preventDefault();
        this.move(1);
        return;
      }
      if (lk === "p" || lk === "k") {
        e.preventDefault();
        this.move(-1);
        return;
      }
      if (lk === "d") {
        e.preventDefault();
        this.move(8);
        return;
      }
      if (lk === "u") {
        e.preventDefault();
        this.move(-8);
        return;
      }
      if (lk === "c") {
        e.preventDefault();
        this.hide();
        return;
      }
    }
  }

  private move(delta: number): void {
    if (this.entries.length === 0) return;
    this.selectedIdx = clamp(
      this.selectedIdx + delta,
      0,
      this.entries.length - 1,
    );
    this.applySelection();
  }

  private activateSelected(): void {
    const entry = this.entries[this.selectedIdx];
    if (!entry) return;
    this.deps.recordJump();
    this.hide();
    entry.activate();
  }

  // --- Static entry sources ---

  private buildStaticEntries(): void {
    const list: Entry[] = [];

    // Outline — walk the existing DOM so we inherit the outline module's
    // activator closures (no need to re-resolve dests).
    const outlineTree = document.getElementById("outlineTree");
    if (outlineTree) {
      const rows = Array.from(
        outlineTree.querySelectorAll<HTMLElement>(".outline-item"),
      );
      for (const row of rows) {
        const title = (row.textContent ?? "").trim();
        if (!title) continue;
        list.push({
          kind: "section",
          label: title,
          page: 0,
          score: 0,
          activate: () => row.click(),
        });
      }
    }

    // Figure / Table captions — detected from page text after indexing.
    if (this.textIndexed) {
      list.push(...this.extractCaptions());
    }

    // Marks
    const allMarks = this.marks.all() as Record<string, MarkPosition>;
    for (const [name, pos] of Object.entries(allMarks)) {
      list.push({
        kind: "mark",
        label: `'${name}`,
        page: pos.page,
        score: 0,
        activate: () => {
          this.viewer.goToPage(pos.page);
          requestAnimationFrame(() => {
            this.viewer.container.scrollTo({
              top: pos.scrollTop,
              left: pos.scrollLeft,
              behavior: "auto",
            });
          });
        },
      });
    }

    // Highlights
    const highlights = this.deps.getHighlights();
    for (const h of highlights) {
      const page = (h.rects[0]?.pageIndex ?? 0) + 1;
      list.push({
        kind: "highlight",
        label: `highlight on page ${page}`,
        page,
        score: 0,
        activate: () => this.viewer.goToPage(page),
      });
    }

    this.staticEntries = list;
  }

  /**
   * Flatten per-page captions (pre-extracted during indexing) into Entry
   * objects, deduped by `(kind, id)` across the whole document.
   */
  private extractCaptions(): Entry[] {
    const out: Entry[] = [];
    const seen = new Set<string>();
    for (let p = 0; p < this.pageCaptions.length; p++) {
      const caps = this.pageCaptions[p];
      if (!caps) continue;
      for (const c of caps) {
        const key = `${c.kindWord}:${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pageNumber = p + 1;
        const preview = c.text.slice(0, 500);
        out.push({
          kind: c.kindWord === "Table" ? "table" : "figure",
          label: c.text.slice(0, 140),
          page: pageNumber,
          score: 0,
          activate: () => this.viewer.goToPage(pageNumber),
          previewBody: preview,
          previewBoldEnd: Math.min(c.markerLen, preview.length),
        });
      }
    }
    return out;
  }

  // --- Full-text indexing ---

  private async indexText(): Promise<void> {
    const doc = this.viewer.pdfDocument;
    if (!doc) return;
    this.textIndexing = true;
    const total = doc.numPages;
    this.pageText = new Array(total).fill("");
    this.pageCaptions = Array.from({ length: total }, () => []);
    const BATCH = 4;
    try {
      for (let i = 0; i < total; i += BATCH) {
        const end = Math.min(total, i + BATCH);
        await Promise.all(
          Array.from({ length: end - i }, (_, k) =>
            this.indexPage(i + k + 1),
          ),
        );
        if (this.open) {
          this.statusEl.textContent = `indexing ${end}/${total}…`;
        }
        await yieldToUi();
      }
      this.textIndexed = true;
      if (this.open) {
        this.statusEl.textContent = "";
        // Rebuild so figure/table captions (which need page text) appear
        // in the static list, then refresh regardless of query state.
        this.buildStaticEntries();
        this.refresh();
      }
    } finally {
      this.textIndexing = false;
    }
  }

  private async indexPage(pageNumber: number): Promise<void> {
    const doc = this.viewer.pdfDocument;
    if (!doc) return;
    try {
      const page = await doc.getPage(pageNumber);
      const tc = await page.getTextContent();

      // Collect text items with PDF-space positions. We rely on `transform`
      // (the final positioning matrix: X = [4], Y = [5]) instead of
      // `hasEOL`, which PDF.js synthesises heuristically and gets wrong on
      // multi-column layouts.
      type Item = { str: string; x: number; y: number; endX: number };
      const items: Item[] = [];
      for (const raw of tc.items) {
        if (!("str" in raw)) continue;
        if (!raw.str) continue;
        const x = raw.transform[4];
        const y = raw.transform[5];
        const w = (raw as { width?: number }).width ?? 0;
        items.push({ str: raw.str, x, y, endX: x + w });
      }
      // Top-to-bottom (Y desc in PDF space), then left-to-right within a row.
      const Y_TOL = 3;
      items.sort((a, b) => {
        if (Math.abs(a.y - b.y) > Y_TOL) return b.y - a.y;
        return a.x - b.x;
      });

      // Group into lines. Split when Y shifts, or when same-Y items have
      // a big X gap (typical of column breaks). 25pt is below an IEEE
      // gutter (~20–25pt) but well above normal word spacing.
      const X_GAP_COL = 25;
      const lines: string[] = [];
      let bucket: Item[] = [];
      const flush = () => {
        if (bucket.length === 0) return;
        const text = bucket
          .map((i) => i.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) lines.push(text);
        bucket = [];
      };
      for (const it of items) {
        const prev = bucket[bucket.length - 1];
        if (
          prev &&
          (Math.abs(it.y - prev.y) > Y_TOL || it.x - prev.endX > X_GAP_COL)
        ) {
          flush();
        }
        bucket.push(it);
      }
      flush();

      // Caption detection: a line that *starts* with "Figure N" / "Fig. N"
      // / "Table N". Body references like "…as shown in Figure 5, the…"
      // are excluded structurally (they're never at line start).
      const caps: Array<{
        text: string;
        markerLen: number;
        kindWord: "Figure" | "Table";
        id: string;
      }> = [];
      const seenOnPage = new Set<string>();
      for (const line of lines) {
        const m = line.match(CAPTION_LINE_RE);
        if (!m) continue;
        const kindWord: "Figure" | "Table" = m[1]
          .toLowerCase()
          .startsWith("t")
          ? "Table"
          : "Figure";
        const id = m[2];
        const key = `${kindWord}:${id}`;
        if (seenOnPage.has(key)) continue;
        seenOnPage.add(key);
        caps.push({ text: line, markerLen: m[0].length, kindWord, id });
      }

      this.pageCaptions[pageNumber - 1] = caps;
      this.pageText[pageNumber - 1] = lines.join("\n");
    } catch {
      // skip failures — page stays empty
    }
  }

  // --- Filtering ---

  private refresh(): void {
    const query = this.inputEl.value.trim();
    const entries: Entry[] = [];

    if (!query) {
      for (const e of this.staticEntries) {
        entries.push({ ...e, score: 0 });
      }
    } else {
      const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      for (const e of this.staticEntries) {
        const m = matchQuery(e.label.toLowerCase(), tokens, false);
        if (m) entries.push({ ...e, score: m.score, matchIdx: m.positions });
      }
      if (this.textIndexed) {
        // Telescope `live_grep`-style: each line containing all tokens is
        // one result. Lines come from the Y-grouping in `indexPage`, so
        // they correspond to visually distinct rows in the PDF.
        const pageHits: Array<{
          page: number;
          lineStart: number;
          match: MatchResult;
        }> = [];
        for (let p = 0; p < this.pageText.length; p++) {
          const text = this.pageText[p];
          if (!text) continue;
          const lower = text.toLowerCase();
          let perPageCount = 0;
          let offset = 0;
          // Split on \n without losing positions: step through manually.
          while (offset <= lower.length) {
            if (perPageCount >= PER_PAGE_HIT_CAP) break;
            const nl = lower.indexOf("\n", offset);
            const lineEnd = nl < 0 ? lower.length : nl;
            if (lineEnd > offset) {
              const line = lower.slice(offset, lineEnd);
              const m = matchQuery(line, tokens, false);
              if (m) {
                pageHits.push({
                  page: p + 1,
                  lineStart: offset,
                  match: {
                    positions: m.positions.map((pos) => pos + offset),
                    bestStart: m.bestStart + offset,
                    bestEnd: m.bestEnd + offset,
                    score: m.score,
                  },
                });
                perPageCount++;
              }
            }
            if (nl < 0) break;
            offset = nl + 1;
          }
        }
        pageHits.sort(
          (a, b) => b.match.score - a.match.score || a.page - b.page,
        );
        for (const hit of pageHits.slice(0, MAX_TEXT_HITS)) {
          const pageText = this.pageText[hit.page - 1];
          const snip = buildSnippet(
            pageText,
            hit.match.bestStart,
            hit.match.bestEnd,
            hit.match.positions,
          );
          entries.push({
            kind: "text",
            label: snip.text,
            page: hit.page,
            score: hit.match.score,
            matchIdx: snip.positions,
            activate: () => this.viewer.goToPage(hit.page),
            snippet: snip.text,
            pageHitStart: hit.match.bestStart,
            pageHitEnd: hit.match.bestEnd,
            pageMatchPositions: hit.match.positions,
          });
        }
      }
      entries.sort((a, b) => {
        // static matches first, sorted by score desc
        if (a.kind === "text" && b.kind !== "text") return 1;
        if (a.kind !== "text" && b.kind === "text") return -1;
        return b.score - a.score;
      });
    }

    this.entries = entries;
    this.selectedIdx = 0;
    this.renderList();
    this.applySelection();

    if (!this.textIndexed && this.textIndexing) {
      this.statusEl.textContent = "indexing full text…";
    } else {
      this.statusEl.textContent = `${entries.length} result${
        entries.length === 1 ? "" : "s"
      }`;
    }
  }

  private renderList(): void {
    const frag = document.createDocumentFragment();
    this.entries.forEach((e, idx) => {
      const row = document.createElement("div");
      row.className = "finder-row";
      row.dataset.idx = String(idx);

      const badge = document.createElement("span");
      badge.className = `finder-badge kind-${e.kind}`;
      badge.textContent = e.kind;
      row.appendChild(badge);

      const label = document.createElement("span");
      label.className = "finder-label";
      if (e.matchIdx && e.matchIdx.length > 0) {
        appendFuzzyHighlighted(label, e.label, e.matchIdx);
      } else {
        label.textContent = e.label;
      }
      row.appendChild(label);

      const page = document.createElement("span");
      page.className = "finder-page";
      page.textContent = e.page > 0 ? `p.${e.page}` : "";
      row.appendChild(page);

      frag.appendChild(row);
    });
    this.listEl.replaceChildren(frag);
  }

  private applySelection(): void {
    const rows = Array.from(
      this.listEl.querySelectorAll<HTMLElement>(".finder-row"),
    );
    rows.forEach((r, i) =>
      r.classList.toggle("selected", i === this.selectedIdx),
    );
    const sel = rows[this.selectedIdx];
    if (sel) {
      const sr = this.listEl.getBoundingClientRect();
      const rr = sel.getBoundingClientRect();
      if (rr.top < sr.top) this.listEl.scrollTop += rr.top - sr.top - 4;
      else if (rr.bottom > sr.bottom)
        this.listEl.scrollTop += rr.bottom - sr.bottom + 4;
    }
    void this.renderPreview();
  }

  private async renderPreview(): Promise<void> {
    const token = ++this.previewToken;
    const entry = this.entries[this.selectedIdx];
    this.previewEl.replaceChildren();
    if (!entry) return;

    const header = document.createElement("div");
    header.className = "finder-preview-header";
    header.textContent =
      entry.page > 0
        ? `${entry.kind} · page ${entry.page}`
        : `${entry.kind}`;
    this.previewEl.appendChild(header);

    if (entry.page > 0) {
      const thumbWrap = document.createElement("div");
      thumbWrap.className = "finder-preview-thumb";
      thumbWrap.textContent = "rendering…";
      this.previewEl.appendChild(thumbWrap);
      const canvas = await this.getThumbnail(entry.page);
      if (token !== this.previewToken) return;
      thumbWrap.replaceChildren();
      if (canvas) thumbWrap.appendChild(canvas);
      else thumbWrap.textContent = "(preview unavailable)";
    }

    const body = document.createElement("div");
    body.className = "finder-preview-body";
    if (entry.previewBody !== undefined) {
      const text = entry.previewBody.replace(/\n/g, " ");
      const boldEnd = Math.min(entry.previewBoldEnd ?? 0, text.length);
      if (boldEnd > 0) {
        const b = document.createElement("b");
        b.textContent = text.slice(0, boldEnd);
        body.appendChild(b);
        body.appendChild(document.createTextNode(text.slice(boldEnd)));
      } else {
        body.textContent = text;
      }
    } else if (
      entry.kind === "text" &&
      entry.pageHitStart !== undefined &&
      entry.pageHitEnd !== undefined
    ) {
      const pageText = this.pageText[entry.page - 1] ?? "";
      const start = Math.max(0, entry.pageHitStart - 200);
      const end = Math.min(pageText.length, entry.pageHitEnd + 300);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < pageText.length ? "…" : "";
      // Flatten newlines into spaces — preserving line breaks makes the
      // preview tall and stringy, and the reader doesn't care about the
      // PDF's line wrapping here (they're reading the matched passage,
      // not the layout). Single-char replacement keeps match positions
      // aligned with the text.
      const sliceText = pageText.slice(start, end).replace(/\n/g, " ");
      const positions = (entry.pageMatchPositions ?? [])
        .filter((p) => p >= start && p < end)
        .map((p) => p - start + prefix.length);
      appendFuzzyHighlighted(body, prefix + sliceText + suffix, positions);
    } else if (entry.page > 0 && this.textIndexed) {
      const pageText = this.pageText[entry.page - 1] ?? "";
      body.textContent =
        pageText.slice(0, 500).replace(/\n/g, " ") ||
        "(no text on this page)";
    } else if (!this.textIndexed) {
      body.textContent = "(full text index building…)";
    }
    this.previewEl.appendChild(body);
  }

  private async getThumbnail(
    pageNumber: number,
  ): Promise<HTMLCanvasElement | null> {
    const cached = this.thumbCache.get(pageNumber);
    if (cached) return cached;
    if (this.thumbInFlight.has(pageNumber)) {
      // simple coalesce: wait for any existing render, then retry
      await new Promise((r) => setTimeout(r, 50));
      return this.thumbCache.get(pageNumber) ?? null;
    }
    this.thumbInFlight.add(pageNumber);
    const doc = this.viewer.pdfDocument;
    if (!doc) {
      this.thumbInFlight.delete(pageNumber);
      return null;
    }
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PREVIEW_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      await page.render({ canvasContext: ctx, viewport }).promise;
      this.thumbCache.set(pageNumber, canvas);
      return canvas;
    } catch {
      return null;
    } finally {
      this.thumbInFlight.delete(pageNumber);
    }
  }
}

// --- helpers ---

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function yieldToUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface MatchResult {
  positions: number[]; // sorted unique char indices within hay
  bestStart: number;   // leftmost matched pos
  bestEnd: number;     // rightmost matched pos + 1
  score: number;
}

/**
 * Telescope-style multi-token fuzzy matcher.
 *
 * The query is tokenized on whitespace; every token must be found in the
 * haystack. For each token we try a case-insensitive substring first, then
 * fall back to subsequence matching (each char of the token appears in
 * order, tolerating typos / gaps). In text mode — used when searching full
 * page text — we reject subsequence matches whose span is much larger than
 * the token itself, so that random characters don't noise up the results.
 *
 * Scoring rewards substring hits, word-boundary starts, consecutive chars,
 * and matches whose tokens cluster together in the haystack.
 */
function matchQuery(
  hay: string,
  tokens: string[],
  textMode: boolean,
): MatchResult | null {
  if (tokens.length === 0) {
    return { positions: [], bestStart: 0, bestEnd: 0, score: 0 };
  }
  let total = 0;
  const allPositions: number[] = [];
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const token of tokens) {
    const m = matchToken(hay, token, textMode);
    if (!m) return null;
    total += m.score;
    for (const p of m.positions) allPositions.push(p);
    minStart = Math.min(minStart, m.positions[0]);
    maxEnd = Math.max(maxEnd, m.positions[m.positions.length - 1] + 1);
  }
  // Cluster bonus: penalise large spans between tokens.
  total -= Math.max(0, maxEnd - minStart - 40) * 0.4;
  const positions = Array.from(new Set(allPositions)).sort((a, b) => a - b);
  return { positions, bestStart: minStart, bestEnd: maxEnd, score: total };
}

function matchToken(
  hay: string,
  token: string,
  textMode: boolean,
): { positions: number[]; score: number } | null {
  // Substring (strongest evidence).
  const si = hay.indexOf(token);
  if (si >= 0) {
    const positions: number[] = [];
    for (let k = 0; k < token.length; k++) positions.push(si + k);
    let score = 1000 + token.length * 10;
    const prev = si === 0 ? " " : hay[si - 1];
    if (isBoundary(prev)) score += 300;
    return { positions, score };
  }
  // Subsequence fallback — typo/gap tolerant.
  let hi = 0;
  const positions: number[] = [];
  for (const c of token) {
    while (hi < hay.length && hay[hi] !== c) hi++;
    if (hi >= hay.length) return null;
    positions.push(hi);
    hi++;
  }
  const span = positions[positions.length - 1] + 1 - positions[0];
  // In long-text mode, disallow loose matches that span huge regions —
  // otherwise every page trivially "matches" any short query.
  if (textMode && span > Math.max(token.length * 6, 25)) return null;
  let score = 120;
  let consecutive = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (i > 0 && p === positions[i - 1] + 1) {
      consecutive += 1;
      score += 10 + consecutive * 6;
    } else {
      consecutive = 0;
    }
    const prev = p === 0 ? " " : hay[p - 1];
    if (isBoundary(prev)) score += 35;
  }
  score -= (span - token.length) * 1.5;
  return { positions, score };
}

function isBoundary(c: string): boolean {
  return (
    c === " " ||
    c === "\n" ||
    c === "\t" ||
    c === "-" ||
    c === "_" ||
    c === "/" ||
    c === "." ||
    c === "," ||
    c === ";" ||
    c === ":" ||
    c === "(" ||
    c === "["
  );
}

/**
 * Cut a readable window of page text around the matched range. Positions
 * are translated into the snippet's coordinate space so the UI can bold
 * each matched character precisely (for both single-token substrings and
 * multi-token fuzzy hits).
 */
function buildSnippet(
  pageText: string,
  bestStart: number,
  bestEnd: number,
  matchPositions: number[],
): { text: string; positions: number[] } {
  const before = 30;
  const after = 90;
  const s = Math.max(0, bestStart - before);
  const e = Math.min(pageText.length, bestEnd + after);
  // Preserve length while replacing whitespace so positions stay aligned.
  const slice = pageText.slice(s, e).replace(/[\r\n\t]/g, " ");
  const prefix = s > 0 ? "…" : "";
  const suffix = e < pageText.length ? "…" : "";
  const text = prefix + slice + suffix;
  const offset = prefix.length - s;
  const positions: number[] = [];
  for (const p of matchPositions) {
    if (p >= s && p < e) positions.push(p + offset);
  }
  return { text, positions };
}

function appendFuzzyHighlighted(
  el: HTMLElement,
  label: string,
  positions: number[],
): void {
  let cursor = 0;
  for (const p of positions) {
    if (p > cursor)
      el.appendChild(document.createTextNode(label.slice(cursor, p)));
    const b = document.createElement("b");
    b.textContent = label[p];
    el.appendChild(b);
    cursor = p + 1;
  }
  if (cursor < label.length)
    el.appendChild(document.createTextNode(label.slice(cursor)));
}
