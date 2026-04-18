/**
 * Modal text-caret navigation over the PDF.js text layer, modeled on Vim.
 *
 * Caret unit: (pageIdx, spanIdx, charOffset) — char-level precision within
 * each .textLayer leaf span. charOffset is in [0, span.length - 1] and
 * represents the character *under* the caret (Vim normal-mode convention),
 * not an insertion gap.
 *
 * Modes:
 *  insert         — caret + movement
 *  visual         — charwise selection (v)
 *  visual-line    — linewise selection (V)
 *  visual-block   — rectangular selection (Ctrl-V / Ctrl-Q)
 *
 * Movement:
 *  h / l          — prev / next char
 *  w / b / e      — next word start / prev word start / next word end
 *  j / k          — next / prev line, preferring same column; falls back to
 *                   reading-order (bottom of left column → top of right column)
 *  0 / $          — line start / end
 *  gg / G / {n}G  — first / last / nth page first span
 *
 * Visual ops (exit to insert after completing):
 *  y  — yank to clipboard (linewise adds newline separators)
 *  H  — save selection as persistent highlight
 */

import type { Viewer } from "./viewer";
import type { Highlight, HighlightRect } from "./highlights";

export type CaretModeKind =
  | "off"
  | "insert"
  | "visual"
  | "visual-line"
  | "visual-block";

export interface Caret {
  pageIdx: number;
  spanIdx: number;
  charOffset: number;
}

export class CaretMode {
  private kind: CaretModeKind = "off";
  private caret: Caret | null = null;
  private anchor: Caret | null = null;

  // Multi-key buffers for gg, {n}G, zz/zt/zb, etc.
  private pendingG = false;
  private pendingZ = false;
  private pendingCount = "";

  constructor(private viewer: Viewer) {}

  get isActive(): boolean {
    return this.kind !== "off";
  }

  get isInsert(): boolean {
    return this.kind === "insert";
  }

  /**
   * Force-refresh the caret from the current viewport state. Used after a
   * jump-list navigation (Ctrl-O/Ctrl-I) performed while in insert mode.
   */
  reseed(): void {
    if (this.kind !== "insert") return;
    const c = this.findStartCaret();
    if (c) {
      this.caret = c;
      this.render();
    }
  }

  enterInsert(): void {
    const currentPageIdx = this.viewer.currentPage - 1;
    // Recompute the caret if (a) there's no prior caret, (b) the visible
    // page changed, or (c) a link/outline/find jump happened — the latter
    // matters for in-page citation jumps where pageIdx alone doesn't change.
    const pendingJump = this.viewer.lastJumpDest !== null;
    if (
      !this.caret ||
      this.caret.pageIdx !== currentPageIdx ||
      pendingJump
    ) {
      this.caret = this.findStartCaret();
    }
    if (!this.caret) {
      this.viewer.setStatusCenter("no text on this page");
      setTimeout(() => this.viewer.clearStatusCenter(), 1000);
      return;
    }
    this.kind = "insert";
    this.viewer.setModeLabel("-- INSERT --");
    this.render();
  }

  exit(): void {
    this.kind = "off";
    this.anchor = null;
    this.pendingG = false;
    this.pendingZ = false;
    this.pendingCount = "";
    this.viewer.setModeLabel("");
    this.clearOverlays();
  }

  private enterVisual(kind: "visual" | "visual-line" | "visual-block"): void {
    if (!this.caret) return;
    this.kind = kind;
    this.anchor = { ...this.caret };
    this.viewer.setModeLabel(
      kind === "visual"
        ? "-- VISUAL --"
        : kind === "visual-line"
          ? "-- V-LINE --"
          : "-- V-BLOCK --",
    );
    this.render();
  }

  private toInsert(): void {
    this.kind = "insert";
    this.anchor = null;
    this.pendingG = false;
    this.pendingZ = false;
    this.pendingCount = "";
    this.viewer.setModeLabel("-- INSERT --");
    this.render();
  }

  handleKey(e: KeyboardEvent): void {
    const k = e.key;

    if (k === "Escape") {
      e.preventDefault();
      if (this.kind === "insert") this.exit();
      else this.toInsert();
      return;
    }

    // Ctrl-V / Ctrl-Q: blockwise visual (Ctrl-Q is a Vim-terminal alias).
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const lk = k.toLowerCase();
      if (lk === "v" || lk === "q") {
        e.preventDefault();
        if (this.kind === "visual-block") this.toInsert();
        else this.enterVisual("visual-block");
        return;
      }
      if ((lk === "l" || lk === "h") && this.caret) {
        e.preventDefault();
        const next = this.columnJump(this.caret, lk === "l" ? 1 : -1);
        if (next) {
          this.caret = next;
          this.render();
        }
        return;
      }
    }

    if (!this.caret) return;

    // z-prefix: zz (center caret), zt (top), zb (bottom).
    if (this.pendingZ) {
      this.pendingZ = false;
      if (k === "z" || k === "t" || k === "b") {
        e.preventDefault();
        this.scrollCaretTo(k === "z" ? "center" : k === "t" ? "top" : "bottom");
        return;
      }
      // fallthrough — z was not followed by a known key
    }
    if (k === "z" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.pendingZ = true;
      return;
    }

    // Digit prefix for counts: {n}G, {n}j, etc. Lone "0" remains line-start.
    if (/^[0-9]$/.test(k) && !(k === "0" && this.pendingCount === "")) {
      e.preventDefault();
      this.pendingCount += k;
      return;
    }

    // gg sequence
    if (k === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (this.pendingG) {
        this.pendingG = false;
        const n = this.consumeCount();
        void this.gotoPageCaret(n > 0 ? n : 1);
      } else {
        this.pendingG = true;
      }
      return;
    }
    this.pendingG = false;

    if (k === "G") {
      e.preventDefault();
      const n = this.consumeCount();
      if (n > 0) void this.gotoPageCaret(n);
      else void this.gotoLastCaret();
      return;
    }

    const count = Math.max(1, this.consumeCount());
    const repeat = (fn: (c: Caret) => Caret): void => {
      let next = this.caret!;
      for (let i = 0; i < count; i++) next = fn.call(this, next);
      this.caret = next;
      this.render();
    };

    switch (k) {
      case "h":
        e.preventDefault();
        repeat((c) => this.moveLeft(c));
        return;
      case "l":
        e.preventDefault();
        repeat((c) => this.moveRight(c));
        return;
      case "w":
        e.preventDefault();
        repeat((c) => this.wordNext(c));
        return;
      case "b":
        e.preventDefault();
        repeat((c) => this.wordPrev(c));
        return;
      case "e":
        e.preventDefault();
        repeat((c) => this.wordEnd(c));
        return;
      case "j":
        e.preventDefault();
        repeat((c) => this.moveVertical(c, 1));
        return;
      case "k":
        e.preventDefault();
        repeat((c) => this.moveVertical(c, -1));
        return;
      case "0":
        e.preventDefault();
        this.caret = this.lineStart(this.caret);
        this.render();
        return;
      case "$":
        e.preventDefault();
        this.caret = this.lineEnd(this.caret);
        this.render();
        return;
    }

    // Mode changes
    if (k === "v") {
      e.preventDefault();
      if (this.kind === "visual") this.toInsert();
      else this.enterVisual("visual");
      return;
    }
    if (k === "V") {
      e.preventDefault();
      if (this.kind === "visual-line") this.toInsert();
      else this.enterVisual("visual-line");
      return;
    }

    // Operators (visual modes only)
    if (this.kind === "insert") return;

    if (k === "y") {
      e.preventDefault();
      void this.yankSelection().then(() => this.toInsert());
      return;
    }
    if (k === "H") {
      e.preventDefault();
      void this.highlightSelection().then(() => this.toInsert());
      return;
    }
  }

  render(): void {
    this.clearOverlays();
    if (this.kind === "off" || !this.caret) return;

    const span = this.spanAt(this.caret);
    if (!span) return;
    const pageEl = span.closest(".page") as HTMLElement | null;
    if (!pageEl) return;

    const r = this.charRect(span, this.caret.charOffset);
    const caretEl =
      r !== null
        ? rectToBox(r, pageEl, "vim-caret")
        : overlayOver(span, pageEl, "vim-caret");
    pageEl.appendChild(caretEl);
    span.scrollIntoView({ block: "nearest", inline: "nearest" });

    if (this.anchor && this.kind !== "insert") {
      this.renderSelection(this.anchor, this.caret);
    }
  }

  // --- Rendering helpers ---

  private renderSelection(a: Caret, b: Caret): void {
    if (this.kind === "visual-block") {
      this.renderBlockSelection(a, b);
      return;
    }

    let [s, end] = orderCarets(a, b);
    if (this.kind === "visual-line") {
      s = this.lineStart(s);
      end = this.lineEnd(end);
    }

    for (let p = s.pageIdx; p <= end.pageIdx; p++) {
      const spans = this.getPageSpans(p);
      if (spans.length === 0) continue;
      const pageEl = this.pageElement(p);
      if (!pageEl) continue;
      const layer = document.createElement("div");
      layer.className = "vim-selection";
      const from = p === s.pageIdx ? s.spanIdx : 0;
      const to = p === end.pageIdx ? end.spanIdx : spans.length - 1;
      for (let i = from; i <= to; i++) {
        const span = spans[i];
        const len = (span.textContent ?? "").length;
        let startChar = 0;
        let endChar = len;
        if (this.kind === "visual") {
          if (p === s.pageIdx && i === s.spanIdx) startChar = s.charOffset;
          if (p === end.pageIdx && i === end.spanIdx)
            endChar = Math.min(len, end.charOffset + 1);
        }
        const rect = this.charRangeRect(span, startChar, endChar);
        if (rect) layer.appendChild(rectToBox(rect, pageEl, "vim-selection-box"));
      }
      pageEl.appendChild(layer);
    }
  }

  private renderBlockSelection(a: Caret, b: Caret): void {
    if (a.pageIdx !== b.pageIdx) return; // blockwise stays on one page
    const aSpan = this.spanAt(a);
    const bSpan = this.spanAt(b);
    if (!aSpan || !bSpan) return;
    const aR = this.charRect(aSpan, a.charOffset) ?? aSpan.getBoundingClientRect();
    const bR = this.charRect(bSpan, b.charOffset) ?? bSpan.getBoundingClientRect();
    const left = Math.min(aR.left, bR.left);
    const right = Math.max(aR.right, bR.right);
    const top = Math.min(aR.top, bR.top);
    const bottom = Math.max(aR.bottom, bR.bottom);
    const pageEl = this.pageElement(a.pageIdx);
    if (!pageEl) return;
    const pageRect = pageEl.getBoundingClientRect();
    const layer = document.createElement("div");
    layer.className = "vim-selection";
    for (const span of this.getPageSpans(a.pageIdx)) {
      const r = span.getBoundingClientRect();
      if (r.right < left || r.left > right) continue;
      if (r.bottom < top || r.top > bottom) continue;
      const ol = Math.max(left, r.left);
      const or = Math.min(right, r.right);
      const ot = Math.max(top, r.top);
      const ob = Math.min(bottom, r.bottom);
      if (or <= ol || ob <= ot) continue;
      const box = document.createElement("div");
      box.className = "vim-selection-box";
      box.style.position = "absolute";
      box.style.left = `${((ol - pageRect.left) / pageRect.width) * 100}%`;
      box.style.top = `${((ot - pageRect.top) / pageRect.height) * 100}%`;
      box.style.width = `${((or - ol) / pageRect.width) * 100}%`;
      box.style.height = `${((ob - ot) / pageRect.height) * 100}%`;
      layer.appendChild(box);
    }
    pageEl.appendChild(layer);
  }

  private clearOverlays(): void {
    document
      .querySelectorAll(".vim-caret, .vim-selection")
      .forEach((el) => el.remove());
  }

  // --- Caret construction ---

  /**
   * Seed the caret near whatever just scrolled into view. Priority:
   *   1. If a link/outline/find jump just happened, land at the destination
   *      anchor. Uses the jump's own pageIdx rather than viewer.currentPage
   *      — PDF.js reports currentPageNumber as the page occupying most of
   *      the viewport, which for top-of-viewport citation jumps is often
   *      the *next* page visible below.
   *   2. Otherwise, pick the visible span closest to the viewport top.
   */
  private findStartCaret(): Caret | null {
    const jump = this.viewer.resolveJumpDestClient();
    if (jump) {
      const jumpSpans = this.getPageSpans(jump.pageIdx);
      if (jumpSpans.length > 0) {
        const idx = this.closestSpanTo(jumpSpans, jump.clientX, jump.clientY);
        this.viewer.clearJumpDest();
        if (idx >= 0) {
          return { pageIdx: jump.pageIdx, spanIdx: idx, charOffset: 0 };
        }
      }
    }

    const pageIdx = this.viewer.currentPage - 1;
    const spans = this.getPageSpans(pageIdx);
    if (spans.length === 0) return null;

    const cRect = this.viewer.container.getBoundingClientRect();
    let bestIdx = -1;
    let bestDy = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const r = spans[i].getBoundingClientRect();
      if (r.bottom <= cRect.top) continue;
      if (r.top >= cRect.bottom) continue;
      const dy = Math.abs(r.top - cRect.top);
      if (dy < bestDy) {
        bestDy = dy;
        bestIdx = i;
      }
    }
    return { pageIdx, spanIdx: bestIdx >= 0 ? bestIdx : 0, charOffset: 0 };
  }

  private closestSpanTo(
    spans: HTMLElement[],
    clientX: number | null,
    clientY: number | null,
  ): number {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const r = spans[i].getBoundingClientRect();
      // Prefer spans whose top is near (or just below) the jump's y.
      const dy = clientY !== null ? Math.max(0, r.top - clientY) + Math.max(0, clientY - r.bottom) : 0;
      const dx = clientX !== null ? Math.max(0, r.left - clientX) + Math.max(0, clientX - r.right) : 0;
      // Weight y more heavily: we only want to disambiguate column via x.
      const d = dy * 2 + dx;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  private consumeCount(): number {
    const n = this.pendingCount ? parseInt(this.pendingCount, 10) : 0;
    this.pendingCount = "";
    return n;
  }

  private async gotoPageCaret(page: number): Promise<void> {
    const pageIdx = Math.min(
      Math.max(0, page - 1),
      this.viewer.numPages - 1,
    );
    this.viewer.goToPage(pageIdx + 1);
    const caret = await this.resolveCaret(() => {
      const spans = this.getPageSpans(pageIdx);
      if (spans.length === 0) return null;
      return { pageIdx, spanIdx: 0, charOffset: 0 };
    });
    if (caret) {
      this.caret = caret;
      this.render();
    }
  }

  private async gotoLastCaret(): Promise<void> {
    const lastPage = this.viewer.numPages - 1;
    this.viewer.goToPage(lastPage + 1);
    const caret = await this.resolveCaret(() => {
      const spans = this.getPageSpans(lastPage);
      if (spans.length === 0) return null;
      const last = spans[spans.length - 1];
      const len = (last.textContent ?? "").length;
      return {
        pageIdx: lastPage,
        spanIdx: spans.length - 1,
        charOffset: Math.max(0, len - 1),
      };
    });
    if (caret) {
      this.caret = caret;
      this.render();
    }
  }

  /**
   * Poll until the text layer for the target page has rendered. PDF.js is
   * lazy, so jumping to a distant page doesn't immediately yield spans.
   */
  private async resolveCaret(
    attempt: () => Caret | null,
  ): Promise<Caret | null> {
    for (let i = 0; i < 30; i++) {
      const c = attempt();
      if (c) return c;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // --- Movement primitives ---

  private moveRight(c: Caret): Caret {
    const span = this.spanAt(c);
    if (!span) return c;
    const len = (span.textContent ?? "").length;
    if (c.charOffset + 1 < len) {
      return { ...c, charOffset: c.charOffset + 1 };
    }
    const spans = this.getPageSpans(c.pageIdx);
    if (c.spanIdx + 1 < spans.length) {
      return { pageIdx: c.pageIdx, spanIdx: c.spanIdx + 1, charOffset: 0 };
    }
    if (c.pageIdx + 1 < this.viewer.numPages) {
      this.ensurePageRendered(c.pageIdx + 1);
      const next = this.getPageSpans(c.pageIdx + 1);
      if (next.length > 0) {
        return { pageIdx: c.pageIdx + 1, spanIdx: 0, charOffset: 0 };
      }
    }
    return c;
  }

  private moveLeft(c: Caret): Caret {
    if (c.charOffset > 0) return { ...c, charOffset: c.charOffset - 1 };
    if (c.spanIdx > 0) {
      const spans = this.getPageSpans(c.pageIdx);
      const prev = spans[c.spanIdx - 1];
      const len = (prev.textContent ?? "").length;
      return {
        pageIdx: c.pageIdx,
        spanIdx: c.spanIdx - 1,
        charOffset: Math.max(0, len - 1),
      };
    }
    if (c.pageIdx > 0) {
      this.ensurePageRendered(c.pageIdx - 1);
      const prev = this.getPageSpans(c.pageIdx - 1);
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        const len = (last.textContent ?? "").length;
        return {
          pageIdx: c.pageIdx - 1,
          spanIdx: prev.length - 1,
          charOffset: Math.max(0, len - 1),
        };
      }
    }
    return c;
  }

  /**
   * Vim `w`: advance to the start of the next word. Words are runs of
   * keyword chars ([A-Za-z0-9_]); punctuation counts as its own run.
   * We walk char-by-char across spans so we don't skip an entire line
   * (PDF.js text spans are often whole lines/phrases).
   */
  private wordNext(c: Caret): Caret {
    const startKind = this.charKindAt(c);
    let cur = c;
    // Skip the rest of the current run.
    while (true) {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      if (this.charKindAt(next) !== startKind) { cur = next; break; }
      cur = next;
    }
    // Skip whitespace until we hit the next word/punct run.
    while (this.charKindAt(cur) === "space") {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      cur = next;
    }
    return cur;
  }

  /**
   * Vim `b`: back to the start of the current or previous word.
   */
  private wordPrev(c: Caret): Caret {
    let cur = this.moveLeft(c);
    if (sameCaret(cur, c)) return c;
    while (this.charKindAt(cur) === "space") {
      const prev = this.moveLeft(cur);
      if (sameCaret(prev, cur)) return cur;
      cur = prev;
    }
    const kind = this.charKindAt(cur);
    while (true) {
      const prev = this.moveLeft(cur);
      if (sameCaret(prev, cur)) return cur;
      if (this.charKindAt(prev) !== kind) return cur;
      cur = prev;
    }
  }

  /**
   * Vim `e`: advance to the last char of the current or next word.
   */
  private wordEnd(c: Caret): Caret {
    let cur = this.moveRight(c);
    if (sameCaret(cur, c)) return c;
    while (this.charKindAt(cur) === "space") {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      cur = next;
    }
    const kind = this.charKindAt(cur);
    while (true) {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      if (this.charKindAt(next) !== kind) return cur;
      cur = next;
    }
  }

  private charKindAt(c: Caret): "word" | "punct" | "space" {
    const span = this.spanAt(c);
    if (!span) return "space";
    const text = span.textContent ?? "";
    const ch = text[c.charOffset] ?? " ";
    return classifyChar(ch);
  }

  private moveVertical(c: Caret, dir: 1 | -1): Caret {
    const spans = this.getPageSpans(c.pageIdx);
    const cur = spans[c.spanIdx];
    if (!cur) return c;
    const curR = cur.getBoundingClientRect();

    // 1) Same-column: x-overlap, y below/above.
    let best: { idx: number; dy: number; overlap: number } | null = null;
    for (let i = 0; i < spans.length; i++) {
      if (i === c.spanIdx) continue;
      const r = spans[i].getBoundingClientRect();
      const dy = dir === 1 ? r.top - curR.bottom : curR.top - r.bottom;
      if (dy <= -1) continue;
      const overlap = Math.max(
        0,
        Math.min(r.right, curR.right) - Math.max(r.left, curR.left),
      );
      if (overlap <= 0) continue;
      if (
        !best ||
        dy < best.dy - 0.5 ||
        (Math.abs(dy - best.dy) < 0.5 && overlap > best.overlap)
      ) {
        best = { idx: i, dy, overlap };
      }
    }
    if (best) return { pageIdx: c.pageIdx, spanIdx: best.idx, charOffset: 0 };

    // 2) Reading-order fallback on the same page: bottom of left column → top
    //    of right column (and vice versa). PDF.js text-layer order is the
    //    PDF's content-stream order, which for most papers is column-major.
    if (dir === 1) {
      for (let i = c.spanIdx + 1; i < spans.length; i++) {
        const r = spans[i].getBoundingClientRect();
        if (Math.abs(r.top - curR.top) > curR.height * 0.5) {
          return { pageIdx: c.pageIdx, spanIdx: i, charOffset: 0 };
        }
      }
    } else {
      for (let i = c.spanIdx - 1; i >= 0; i--) {
        const r = spans[i].getBoundingClientRect();
        if (Math.abs(r.top - curR.top) > curR.height * 0.5) {
          return { pageIdx: c.pageIdx, spanIdx: i, charOffset: 0 };
        }
      }
    }

    // 3) Adjacent page.
    if (dir === 1 && c.pageIdx + 1 < this.viewer.numPages) {
      this.ensurePageRendered(c.pageIdx + 1);
      const next = this.getPageSpans(c.pageIdx + 1);
      if (next.length > 0) {
        return { pageIdx: c.pageIdx + 1, spanIdx: 0, charOffset: 0 };
      }
    }
    if (dir === -1 && c.pageIdx > 0) {
      this.ensurePageRendered(c.pageIdx - 1);
      const prev = this.getPageSpans(c.pageIdx - 1);
      if (prev.length > 0) {
        return {
          pageIdx: c.pageIdx - 1,
          spanIdx: prev.length - 1,
          charOffset: 0,
        };
      }
    }
    return c;
  }

  /**
   * Jump to the adjacent column on the same page. Picks the closest span
   * whose horizontal extent lies strictly to the right (dir=1) or left
   * (dir=-1) of the current span, breaking ties by vertical proximity.
   */
  private columnJump(c: Caret, dir: 1 | -1): Caret | null {
    const spans = this.getPageSpans(c.pageIdx);
    const cur = spans[c.spanIdx];
    if (!cur) return null;
    const curR = cur.getBoundingClientRect();
    let best: { idx: number; dx: number; dy: number } | null = null;
    for (let i = 0; i < spans.length; i++) {
      if (i === c.spanIdx) continue;
      const r = spans[i].getBoundingClientRect();
      const dx = dir === 1 ? r.left - curR.right : curR.left - r.right;
      if (dx <= 0) continue;
      const dy = Math.abs(r.top - curR.top);
      if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) {
        best = { idx: i, dx, dy };
      }
    }
    if (!best) return null;
    return { pageIdx: c.pageIdx, spanIdx: best.idx, charOffset: 0 };
  }

  private lineStart(c: Caret): Caret {
    const spans = this.getPageSpans(c.pageIdx);
    const cur = spans[c.spanIdx];
    if (!cur) return c;
    const curR = cur.getBoundingClientRect();
    let idx = c.spanIdx;
    for (let i = c.spanIdx - 1; i >= 0; i--) {
      const r = spans[i].getBoundingClientRect();
      if (Math.abs(r.top - curR.top) > curR.height * 0.5) break;
      idx = i;
    }
    return { pageIdx: c.pageIdx, spanIdx: idx, charOffset: 0 };
  }

  private lineEnd(c: Caret): Caret {
    const spans = this.getPageSpans(c.pageIdx);
    const cur = spans[c.spanIdx];
    if (!cur) return c;
    const curR = cur.getBoundingClientRect();
    let idx = c.spanIdx;
    for (let i = c.spanIdx + 1; i < spans.length; i++) {
      const r = spans[i].getBoundingClientRect();
      if (Math.abs(r.top - curR.top) > curR.height * 0.5) break;
      idx = i;
    }
    const last = spans[idx];
    const len = (last.textContent ?? "").length;
    return {
      pageIdx: c.pageIdx,
      spanIdx: idx,
      charOffset: Math.max(0, len - 1),
    };
  }

  /**
   * Scroll the container so the caret lands at the viewport top / center /
   * bottom. Vim's `zt` / `zz` / `zb`.
   */
  private scrollCaretTo(pos: "top" | "center" | "bottom"): void {
    if (!this.caret) return;
    const span = this.spanAt(this.caret);
    if (!span) return;
    const r = this.charRect(span, this.caret.charOffset) ?? span.getBoundingClientRect();
    const container = this.viewer.container;
    const cRect = container.getBoundingClientRect();
    const caretY = r.top - cRect.top + container.scrollTop;
    let targetTop = caretY;
    if (pos === "center") targetTop = caretY - container.clientHeight / 2 + r.height / 2;
    else if (pos === "bottom") targetTop = caretY - container.clientHeight + r.height;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
    this.render();
  }

  private ensurePageRendered(pageIdx: number): void {
    if (Math.abs(this.viewer.currentPage - (pageIdx + 1)) <= 1) return;
    this.viewer.goToPage(pageIdx + 1);
  }

  // --- Char rect helpers ---

  private charRect(span: HTMLElement, offset: number): DOMRect | null {
    const textNode = firstTextNode(span);
    if (!textNode) return span.getBoundingClientRect();
    const len = (textNode.textContent ?? "").length;
    if (len === 0) return span.getBoundingClientRect();
    const o = Math.min(Math.max(0, offset), len - 1);
    const range = document.createRange();
    range.setStart(textNode, o);
    range.setEnd(textNode, o + 1);
    return range.getBoundingClientRect();
  }

  private charRangeRect(
    span: HTMLElement,
    from: number,
    to: number,
  ): DOMRect | null {
    const textNode = firstTextNode(span);
    if (!textNode) return span.getBoundingClientRect();
    const len = (textNode.textContent ?? "").length;
    if (len === 0) return span.getBoundingClientRect();
    const a = Math.min(Math.max(0, from), len);
    const b = Math.min(Math.max(0, to), len);
    if (a >= b) return null;
    const range = document.createRange();
    range.setStart(textNode, a);
    range.setEnd(textNode, b);
    const rects = range.getClientRects();
    if (rects.length === 0) return range.getBoundingClientRect();
    // TextLayer spans don't wrap — take the first rect.
    return rects[0];
  }

  // --- DOM accessors ---

  private pageElement(pageIdx: number): HTMLElement | null {
    return document.querySelector(
      `.page[data-page-number="${pageIdx + 1}"]`,
    ) as HTMLElement | null;
  }

  private getPageSpans(pageIdx: number): HTMLElement[] {
    const pageEl = this.pageElement(pageIdx);
    if (!pageEl) return [];
    const all = pageEl.querySelectorAll<HTMLElement>(".textLayer span");
    return Array.from(all).filter(
      (s) =>
        s.childElementCount === 0 && (s.textContent?.trim().length ?? 0) > 0,
    );
  }

  private spanAt(c: Caret): HTMLElement | null {
    return this.getPageSpans(c.pageIdx)[c.spanIdx] ?? null;
  }

  // --- Selection extraction ---

  private async yankSelection(): Promise<void> {
    if (!this.caret || !this.anchor) return;
    const text = this.selectionText();
    if (!text) {
      this.viewer.setStatusCenter("empty selection");
      setTimeout(() => this.viewer.clearStatusCenter(), 1000);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.viewer.setStatusCenter(`yanked ${text.length} chars`);
    } catch {
      this.viewer.setStatusCenter("yank failed (clipboard blocked)");
    }
    setTimeout(() => this.viewer.clearStatusCenter(), 1200);
  }

  private selectionText(): string {
    if (!this.caret || !this.anchor) return "";

    if (this.kind === "visual-block") {
      return this.blockSelectionText();
    }

    let [s, end] = orderCarets(this.anchor, this.caret);
    if (this.kind === "visual-line") {
      s = this.lineStart(s);
      end = this.lineEnd(end);
    }

    const lines: string[][] = [];
    let currentLine: string[] = [];
    let lastTop: number | null = null;
    let lastHeight = 0;

    for (let p = s.pageIdx; p <= end.pageIdx; p++) {
      const spans = this.getPageSpans(p);
      const from = p === s.pageIdx ? s.spanIdx : 0;
      const to = p === end.pageIdx ? end.spanIdx : spans.length - 1;
      for (let i = from; i <= to; i++) {
        const span = spans[i];
        const txt = span.textContent ?? "";
        let a = 0;
        let b = txt.length;
        if (this.kind === "visual") {
          if (p === s.pageIdx && i === s.spanIdx) a = s.charOffset;
          if (p === end.pageIdx && i === end.spanIdx)
            b = Math.min(txt.length, end.charOffset + 1);
        }
        const piece = txt.slice(a, b);
        if (!piece) continue;
        const r = span.getBoundingClientRect();
        if (lastTop !== null && Math.abs(r.top - lastTop) > lastHeight * 0.5) {
          lines.push(currentLine);
          currentLine = [];
        }
        currentLine.push(piece);
        lastTop = r.top;
        lastHeight = r.height;
      }
    }
    if (currentLine.length) lines.push(currentLine);
    return lines.map((parts) => parts.join(" ")).join("\n").trim();
  }

  private blockSelectionText(): string {
    if (!this.caret || !this.anchor) return "";
    if (this.caret.pageIdx !== this.anchor.pageIdx) return "";
    const pageIdx = this.caret.pageIdx;
    const aSpan = this.spanAt(this.anchor);
    const bSpan = this.spanAt(this.caret);
    if (!aSpan || !bSpan) return "";
    const aR = this.charRect(aSpan, this.anchor.charOffset) ?? aSpan.getBoundingClientRect();
    const bR = this.charRect(bSpan, this.caret.charOffset) ?? bSpan.getBoundingClientRect();
    const left = Math.min(aR.left, bR.left);
    const right = Math.max(aR.right, bR.right);
    const top = Math.min(aR.top, bR.top);
    const bottom = Math.max(aR.bottom, bR.bottom);

    const byLine: Map<number, string[]> = new Map();
    for (const span of this.getPageSpans(pageIdx)) {
      const r = span.getBoundingClientRect();
      if (r.right < left || r.left > right) continue;
      if (r.bottom < top || r.top > bottom) continue;
      const piece = this.spanSliceInRect(span, left, right);
      if (!piece) continue;
      const line = Math.round(r.top);
      const arr = byLine.get(line) ?? [];
      arr.push(piece);
      byLine.set(line, arr);
    }
    const sortedLines = Array.from(byLine.keys()).sort((a, b) => a - b);
    return sortedLines
      .map((l) => (byLine.get(l) ?? []).join(" "))
      .join("\n")
      .trim();
  }

  /**
   * Return the substring of `span` whose per-char bboxes fall within the
   * horizontal band [left, right]. Used by block-visual yank so the copied
   * text matches the drawn rectangle.
   */
  private spanSliceInRect(
    span: HTMLElement,
    left: number,
    right: number,
  ): string {
    const textNode = firstTextNode(span);
    if (!textNode) return "";
    const text = textNode.textContent ?? "";
    if (!text) return "";
    const range = document.createRange();
    let startChar = -1;
    let endChar = -1;
    for (let i = 0; i < text.length; i++) {
      range.setStart(textNode, i);
      range.setEnd(textNode, i + 1);
      const r = range.getBoundingClientRect();
      if (r.right > left && r.left < right) {
        if (startChar === -1) startChar = i;
        endChar = i + 1;
      }
    }
    if (startChar === -1) return "";
    return text.slice(startChar, endChar);
  }

  private async highlightSelection(): Promise<void> {
    if (!this.caret || !this.anchor) return;
    const rects = this.selectionHighlightRects();
    if (rects.length === 0) return;
    const hl: Highlight = {
      id: Math.random().toString(36).slice(2, 10),
      color: "rgba(255, 230, 0, 0.4)",
      rects,
    };
    await this.viewer.addHighlight(hl);
  }

  private selectionHighlightRects(): HighlightRect[] {
    if (!this.caret || !this.anchor) return [];
    const out: HighlightRect[] = [];

    if (this.kind === "visual-block") {
      if (this.caret.pageIdx !== this.anchor.pageIdx) return [];
      const pageIdx = this.caret.pageIdx;
      const pageEl = this.pageElement(pageIdx);
      if (!pageEl) return [];
      const pageRect = pageEl.getBoundingClientRect();
      const aSpan = this.spanAt(this.anchor);
      const bSpan = this.spanAt(this.caret);
      if (!aSpan || !bSpan) return [];
      const aR = this.charRect(aSpan, this.anchor.charOffset) ?? aSpan.getBoundingClientRect();
      const bR = this.charRect(bSpan, this.caret.charOffset) ?? bSpan.getBoundingClientRect();
      const left = Math.min(aR.left, bR.left);
      const right = Math.max(aR.right, bR.right);
      const top = Math.min(aR.top, bR.top);
      const bottom = Math.max(aR.bottom, bR.bottom);
      for (const span of this.getPageSpans(pageIdx)) {
        const r = span.getBoundingClientRect();
        if (r.right < left || r.left > right) continue;
        if (r.bottom < top || r.top > bottom) continue;
        const ol = Math.max(left, r.left);
        const or = Math.min(right, r.right);
        const ot = Math.max(top, r.top);
        const ob = Math.min(bottom, r.bottom);
        if (or <= ol || ob <= ot) continue;
        out.push({
          pageIndex: pageIdx,
          x: (ol - pageRect.left) / pageRect.width,
          y: (ot - pageRect.top) / pageRect.height,
          w: (or - ol) / pageRect.width,
          h: (ob - ot) / pageRect.height,
        });
      }
      return out;
    }

    let [s, end] = orderCarets(this.anchor, this.caret);
    if (this.kind === "visual-line") {
      s = this.lineStart(s);
      end = this.lineEnd(end);
    }
    for (let p = s.pageIdx; p <= end.pageIdx; p++) {
      const pageEl = this.pageElement(p);
      if (!pageEl) continue;
      const pageRect = pageEl.getBoundingClientRect();
      const spans = this.getPageSpans(p);
      const from = p === s.pageIdx ? s.spanIdx : 0;
      const to = p === end.pageIdx ? end.spanIdx : spans.length - 1;
      for (let i = from; i <= to; i++) {
        const span = spans[i];
        const len = (span.textContent ?? "").length;
        let a = 0;
        let b = len;
        if (this.kind === "visual") {
          if (p === s.pageIdx && i === s.spanIdx) a = s.charOffset;
          if (p === end.pageIdx && i === end.spanIdx)
            b = Math.min(len, end.charOffset + 1);
        }
        const rect = this.charRangeRect(span, a, b);
        if (!rect) continue;
        out.push({
          pageIndex: p,
          x: (rect.left - pageRect.left) / pageRect.width,
          y: (rect.top - pageRect.top) / pageRect.height,
          w: rect.width / pageRect.width,
          h: rect.height / pageRect.height,
        });
      }
    }
    return out;
  }
}

function sameCaret(a: Caret, b: Caret): boolean {
  return (
    a.pageIdx === b.pageIdx &&
    a.spanIdx === b.spanIdx &&
    a.charOffset === b.charOffset
  );
}

function classifyChar(ch: string): "word" | "punct" | "space" {
  if (/\s/.test(ch)) return "space";
  if (/[\p{L}\p{N}_]/u.test(ch)) return "word";
  return "punct";
}

function orderCarets(a: Caret, b: Caret): [Caret, Caret] {
  if (a.pageIdx < b.pageIdx) return [a, b];
  if (a.pageIdx > b.pageIdx) return [b, a];
  if (a.spanIdx < b.spanIdx) return [a, b];
  if (a.spanIdx > b.spanIdx) return [b, a];
  return a.charOffset <= b.charOffset ? [a, b] : [b, a];
}

function firstTextNode(el: HTMLElement): Text | null {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) return node as Text;
  }
  return null;
}

function overlayOver(
  source: HTMLElement,
  pageEl: HTMLElement,
  className: string,
): HTMLElement {
  return rectToBox(source.getBoundingClientRect(), pageEl, className);
}

function rectToBox(
  r: DOMRect,
  pageEl: HTMLElement,
  className: string,
): HTMLElement {
  const pageRect = pageEl.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = className;
  box.style.position = "absolute";
  box.style.left = `${((r.left - pageRect.left) / pageRect.width) * 100}%`;
  box.style.top = `${((r.top - pageRect.top) / pageRect.height) * 100}%`;
  box.style.width = `${(r.width / pageRect.width) * 100}%`;
  box.style.height = `${(r.height / pageRect.height) * 100}%`;
  return box;
}
