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
 *  W / B / E      — same, but punctuation counts as part of the word (WORD)
 *  j / k          — next / prev line, preferring same column; falls back to
 *                   reading-order (bottom of left column → top of right column)
 *  0 / ^ / $      — line start / start / end. 0 and ^ coincide here: the text
 *                   layer has no leading-whitespace spans to skip over
 *  gg / G / {n}G  — first / last / nth page first span
 *
 * Operators — y (yank) and H (save highlight) — take a motion or a text
 * object, in caret mode as well as over a visual selection:
 *  y{motion}      — yw ye yb y0 y$ yj yk, counts on both sides multiplying
 *  yiw / yaw      — inner / a word; iW / aW fold punctuation in
 *  yy / Y         — whole row(s) / to end of row (Y = y$, the Neovim default)
 * Both operators run the same engine; only the terminal call differs. Every
 * target resolves to a CaretRange, which is also what a visual selection
 * produces, so there is one code path rather than two.
 *
 * Three places a text layer cannot honour a Vim rule exactly, all deliberate:
 *  - j / k are geometric display-line moves, so a linewise yank over them is
 *    really Vim's gj / gk;
 *  - a linewise yank appends no trailing newline — there is no newline
 *    character in the document to take;
 *  - `aw` sometimes has to synthesise its trailing space, because pdf.js
 *    drops whitespace-only spans and two words can end up adjacent with no
 *    space character between them at all. That synthetic space rides on the
 *    range, so `yaw` has it but `vaw` then `y` does not: a visual selection
 *    is live state the user can move, and a fabricated character could not
 *    survive the first motion anyway.
 *
 * y falls back to a synchronous copy where the embedder's permissions policy
 * blocks the async Clipboard API, and keeps what it was going to yank if
 * even that fails — see ./clipboard.ts
 */

import type { Viewer } from "./viewer";
import type { Highlight, HighlightRect } from "./highlights";
import { copyText } from "./clipboard";

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

export type SelKind = "visual" | "visual-line" | "visual-block";

/**
 * A span of text to operate on, independent of where the caret happens to
 * be. Operators take one of these so `yiw` and a visual-mode `y` run the
 * same code.
 */
export interface CaretRange {
  kind: SelKind;
  start: Caret;
  /** Inclusive: every consumer slices at `end.charOffset + 1`. */
  end: Caret;
  /**
   * A space `aw` has to invent. Two words can sit in adjacent spans with no
   * whitespace character between them — pdf.js drops whitespace-only spans —
   * and there is no character there to extend the range over. Applied to the
   * yanked text only; a rect consumer must ignore it, since you cannot
   * highlight a character that does not exist.
   */
  pad?: "before" | "after";
}

/** What a motion resolved to, before Vim's inclusive/exclusive rules apply. */
type MotionResult =
  | { t: "charwise"; to: Caret; inclusive: boolean }
  | { t: "linewise"; to: Caret };

/**
 * How far apart two spans may sit, as a fraction of glyph height, before the
 * gap between them counts as a word break — i.e. as the whitespace-only span
 * pdf.js dropped.
 *
 * The two populations this has to separate are a kerning or font-run split
 * inside one word, which leaves a gap of a few hundredths of the height, and
 * a real inter-word space, which is roughly a quarter of it. Sitting near
 * either end misclassifies one of them, so this sits between: low enough that
 * no real space is swallowed, high enough that no kerned pair is torn apart.
 */
const SEAM_GAP_RATIO = 0.12;

export class CaretMode {
  private kind: CaretModeKind = "off";
  private caret: Caret | null = null;
  private anchor: Caret | null = null;

  // Multi-key buffers for gg, {n}G, zz/zt/zb, etc.
  private pendingG = false;
  private pendingZ = false;
  private pendingCount = "";

  // Operator-pending state: `y`/`H` armed and waiting for a motion or a text
  // object. Vim models this as its own mode (`mode()` returns "no") because a
  // pending operator changes the meaning of the whole key stream, and the
  // dispatcher below mirrors that rather than forking every motion branch.
  private pendingOp: "y" | "H" | null = null;
  private opCount = 1; // count typed before the operator
  private opDigits = ""; // count typed after it — the two multiply
  private pendingObject: "i" | "a" | null = null;
  private opEcho = "";
  // Bumped on every mode change and completed operator, so a clipboard
  // round-trip that finishes after the user has moved on can tell.
  private opSeq = 0;
  private flashRange: CaretRange | null = null;

  constructor(private viewer: Viewer) {}

  get isActive(): boolean {
    return this.kind !== "off";
  }

  get isInsert(): boolean {
    return this.kind === "insert";
  }

  get isOperatorPending(): boolean {
    return this.pendingOp !== null;
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
    // Always reseed from the viewport — sticky insert positions feel
    // unpredictable ("why is the caret back in the middle of the previous
    // paragraph?") once you've scrolled or jumped.
    this.caret = this.findStartCaret();
    if (!this.caret) {
      this.viewer.setStatusCenter("no text on this page");
      setTimeout(() => this.viewer.clearStatusCenter(), 1000);
      return;
    }
    this.kind = "insert";
    this.viewer.setModeLabel("-- CARET --");
    this.render();
  }

  exit(): void {
    this.kind = "off";
    this.anchor = null;
    this.clearPending();
    this.viewer.setModeLabel("");
    this.clearOverlays();
  }

  /**
   * Drop every half-typed command. Called on any mode change: an operator
   * left armed across one would swallow the next key the user pressed.
   */
  private clearPending(): void {
    this.pendingOp = null;
    this.pendingObject = null;
    this.opDigits = "";
    this.opCount = 1;
    this.opEcho = "";
    this.pendingG = false;
    this.pendingZ = false;
    this.pendingCount = "";
    this.opSeq++;
  }

  private modeLabelBase(): string {
    switch (this.kind) {
      case "insert":
        return "-- CARET --";
      case "visual":
        return "-- VISUAL --";
      case "visual-line":
        return "-- V-LINE --";
      case "visual-block":
        return "-- V-BLOCK --";
      default:
        return "";
    }
  }

  // Vim's showcmd: the half-typed command trails the mode label, so `2yi`
  // is visible while it waits for its last key. pendingG/pendingZ/count have
  // always been invisible; the operator grammar is deep enough to need it.
  private refreshModeLabel(): void {
    const base = this.modeLabelBase();
    this.viewer.setModeLabel(this.opEcho ? `${base}  ${this.opEcho}` : base);
  }

  private echo(s: string): void {
    this.opEcho = s;
    this.refreshModeLabel();
  }

  private flash(msg: string, ms = 1200): void {
    this.viewer.setStatusCenter(msg);
    setTimeout(() => this.viewer.clearStatusCenter(), ms);
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
    this.clearPending();
    this.viewer.setModeLabel("-- CARET --");
    this.render();
  }

  handleKey(e: KeyboardEvent): void {
    const k = e.key;

    // A bare modifier press is still a keydown. Without this it falls all
    // the way through to the count consumer below, which is why `10G` used
    // to land on the last page: the Shift needed for "G" ate the "10".
    if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") {
      return;
    }

    if (k === "Escape") {
      e.preventDefault();
      // Vim's Normal-mode Esc only throws away the half-typed command; it
      // does not leave the mode. Only an Esc with nothing pending does.
      if (
        this.pendingOp ||
        this.pendingObject ||
        this.opDigits ||
        this.pendingCount ||
        this.pendingG ||
        this.pendingZ
      ) {
        this.clearPending();
        this.refreshModeLabel();
        return;
      }
      if (this.kind === "insert") this.exit();
      else this.toInsert();
      return;
    }

    if (this.pendingObject) {
      this.resolveObjectKey(e);
      return;
    }
    if (this.pendingOp) {
      this.handleOperatorPending(e);
      return;
    }

    // Ctrl-V / Ctrl-Q: blockwise visual (Ctrl-Q is a Vim-terminal alias).
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const lk = k.toLowerCase();
      // Any Ctrl- command ends a half-typed g/z prefix rather than leaving it
      // armed for the next key — or for an Escape that would then do nothing.
      this.pendingG = false;
      this.pendingZ = false;
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
      this.pendingG = false;
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
      case "W":
        e.preventDefault();
        repeat((c) => this.wordNext(c, true));
        return;
      case "b":
        e.preventDefault();
        repeat((c) => this.wordPrev(c));
        return;
      case "B":
        e.preventDefault();
        repeat((c) => this.wordPrev(c, true));
        return;
      case "e":
        e.preventDefault();
        repeat((c) => this.wordEnd(c));
        return;
      case "E":
        e.preventDefault();
        repeat((c) => this.wordEnd(c, true));
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
      case "^":
        // getPageSpans drops whitespace-only spans, so a row's first
        // addressable character is already its first non-blank: in this
        // text model ^ and 0 are the same position.
        e.preventDefault();
        this.caret = this.lineStart(this.caret);
        this.render();
        return;
      case "$":
        e.preventDefault();
        this.caret = this.lineEnd(
          this.repeatFrom(this.caret, count - 1, (c) => this.moveVertical(c, 1)),
        );
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

    // Text-object prefixes. Visual only: in caret mode `i` and `a` have no
    // operator to apply an object to, and `i` is how you enter caret mode in
    // the first place — swallowing it there would be a trap.
    const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
    if ((k === "i" || k === "a") && bare && this.kind !== "insert") {
      e.preventDefault();
      this.pendingObject = k;
      this.opCount = count;
      this.echo(count > 1 ? `${count}${k}` : k);
      return;
    }

    // Operators
    const sel = this.currentRange();

    if (k === "y" && bare) {
      e.preventDefault();
      if (!sel) {
        this.armOperator("y", count);
        return;
      }
      // Hold the selection when the copy actually failed: toInsert() clears
      // the anchor, and throwing away the selection is the difference
      // between a retry and a re-drag. (The "not focused" flavour of
      // failure clears as soon as the user clicks in, so retrying works.)
      void this.yankSelection(sel).then((r) => {
        if (r !== "failed") this.toInsert();
      });
      return;
    }
    if (k === "Y" && bare) {
      e.preventDefault();
      // Neovim's default (Y == y$), not classic Vim's Y == yy. Documented in
      // the help table so nobody has to guess which one they got.
      if (sel) {
        void this.yankSelection({ ...sel, kind: "visual-line" }).then((r) => {
          if (r !== "failed") this.toInsert();
        });
        return;
      }
      const toEol = this.resolveMotion("$", count);
      this.applyRange(toEol && this.rangeFromMotion(this.caret, toEol), "y");
      return;
    }
    if (k === "H" && bare) {
      e.preventDefault();
      if (!sel) {
        this.armOperator("H", count);
        return;
      }
      void this.highlightSelection(sel).then(() => this.toInsert());
      return;
    }
  }

  // --- Operator-pending engine ---

  private armOperator(op: "y" | "H", count: number): void {
    this.pendingOp = op;
    this.opCount = count;
    this.opDigits = "";
    this.echo(count > 1 ? `${count}${op}` : op);
  }

  private abortOperator(msg?: string): void {
    this.clearPending();
    this.refreshModeLabel();
    if (msg) this.flash(msg, 900);
  }

  /** Counts on both sides of the operator multiply: 2y3w is six words. */
  private opRepeat(): number {
    const after = this.opDigits ? parseInt(this.opDigits, 10) : 1;
    return Math.max(1, this.opCount) * Math.max(1, after);
  }

  private handleOperatorPending(e: KeyboardEvent): void {
    const k = e.key;
    const op = this.pendingOp;
    if (!op || !this.caret) {
      this.abortOperator();
      return;
    }
    // A chord — Cmd-A, Ctrl-W — cancels the operator and is left to the
    // browser. Swallowing it would suppress the command the user meant while
    // silently arming an object off its letter.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      this.abortOperator();
      return;
    }
    e.preventDefault();

    // A count typed after the operator. The lone-zero exception is evaluated
    // against these digits, not the pre-operator ones, so `y0` still reaches
    // the row-start motion.
    if (/^[0-9]$/.test(k) && !(k === "0" && this.opDigits === "")) {
      this.opDigits += k;
      this.echo(this.opEcho + k);
      return;
    }

    if (k === "i" || k === "a") {
      this.pendingObject = k;
      this.echo(this.opEcho + k);
      return;
    }

    // Doubled operator — yy, HH — is linewise over N rows.
    if (k === op) {
      const n = this.opRepeat();
      const end = this.repeatFrom(this.caret, n - 1, (c) =>
        this.moveVertical(c, 1),
      );
      this.applyRange(
        { kind: "visual-line", start: this.caret, end },
        op,
      );
      return;
    }

    const motion = this.resolveMotion(k, this.opRepeat());
    if (motion) {
      this.applyRange(this.rangeFromMotion(this.caret, motion), op);
      return;
    }

    // Anything else aborts. Never fall back to a default range: an operator
    // that guesses at its target is how you lose a page of text to a typo.
    this.abortOperator(`${this.opEcho}${k}`);
  }

  private resolveObjectKey(e: KeyboardEvent): void {
    const k = e.key;
    const inner = this.pendingObject === "i";
    const op = this.pendingOp;
    if (!this.caret || e.ctrlKey || e.metaKey || e.altKey) {
      this.abortOperator();
      return;
    }
    e.preventDefault();

    const n = op ? this.opRepeat() : Math.max(1, this.opCount);
    const range =
      k === "w" || k === "W"
        ? this.wordObject(this.caret, inner, k === "W", n)
        : null;

    if (!range) {
      this.abortOperator(`${this.opEcho}${k}`);
      return;
    }
    if (op) {
      this.applyRange(range, op);
      return;
    }

    // Visual mode: the object replaces the selection rather than extending it
    // by one object the way Vim does — with no repeat-object state to track,
    // replacing is the behaviour that matches what the keys look like.
    this.clearPending();
    this.kind = range.kind;
    this.anchor = range.start;
    this.caret = range.end;
    this.refreshModeLabel();
    this.render();
  }

  private applyRange(range: CaretRange | null, op: "y" | "H"): void {
    if (!range) {
      this.abortOperator("nothing to yank");
      return;
    }
    // Clear first and synchronously: a key pressed during the clipboard
    // round-trip must land in a clean caret mode, and nothing between here
    // and copyText() may await — the fallback copy path in ./clipboard.ts
    // spends this keydown's transient user activation.
    this.clearPending();
    const seq = this.opSeq;
    this.refreshModeLabel();
    this.caret = range.start; // Vim leaves the cursor on the first char operated on
    this.flashRange = range;
    this.render();
    setTimeout(() => {
      if (this.flashRange === range) {
        this.flashRange = null;
        this.render();
      }
    }, 220);

    if (op === "H") {
      void this.highlightSelection(range);
      return;
    }
    void this.yankSelection(range).then((r) => {
      if (seq !== this.opSeq) return; // superseded by a later command
      if (r === "failed") {
        // Same promise as the visual-mode path: a blocked copy keeps what it
        // was going to yank. Operator-pending has no selection to preserve,
        // so materialise one over the computed range and let `y` retry.
        this.kind = range.kind;
        this.anchor = range.start;
        this.caret = range.end;
        this.flashRange = null;
        this.refreshModeLabel();
        this.render();
      }
    });
  }

  /** Like the `repeat` closure in handleKey, but pure — it moves no state. */
  private repeatFrom(c: Caret, n: number, fn: (c: Caret) => Caret): Caret {
    let cur = c;
    for (let i = 0; i < n; i++) {
      const next = fn(cur);
      if (sameCaret(next, cur)) break;
      cur = next;
    }
    return cur;
  }

  private resolveMotion(k: string, n: number): MotionResult | null {
    const c = this.caret!;
    switch (k) {
      case "h":
        return { t: "charwise", to: this.repeatFrom(c, n, (x) => this.moveLeft(x)), inclusive: false };
      case "l":
        return { t: "charwise", to: this.repeatFrom(c, n, (x) => this.moveRight(x)), inclusive: false };
      case "w":
      case "W":
        return { t: "charwise", to: this.repeatFrom(c, n, (x) => this.wordNext(x, k === "W")), inclusive: false };
      case "b":
      case "B":
        return { t: "charwise", to: this.repeatFrom(c, n, (x) => this.wordPrev(x, k === "B")), inclusive: false };
      case "e":
      case "E":
        // The one pair that proves the rule: wordEnd already lands on the
        // last char of the word, so an inclusive range needs no adjustment.
        return { t: "charwise", to: this.repeatFrom(c, n, (x) => this.wordEnd(x, k === "E")), inclusive: true };
      case "j":
        return { t: "linewise", to: this.repeatFrom(c, n, (x) => this.moveVertical(x, 1)) };
      case "k":
        return { t: "linewise", to: this.repeatFrom(c, n, (x) => this.moveVertical(x, -1)) };
      case "0":
      case "^":
        // getPageSpans drops whitespace-only spans, so a row's first
        // addressable char is already its first non-blank: ^ and 0 coincide.
        return { t: "charwise", to: this.lineStart(c), inclusive: false };
      case "$":
        // Vim's {count}$ ends on the row count-1 below, which here is the
        // same geometric row move j already makes.
        return {
          t: "charwise",
          to: this.lineEnd(this.repeatFrom(c, n - 1, (x) => this.moveVertical(x, 1))),
          inclusive: true,
        };
      default:
        return null;
    }
  }

  private rangeFromMotion(origin: Caret, m: MotionResult): CaretRange | null {
    // A motion that went nowhere aborts the operator, as in Vim — except for
    // an inclusive one, where landing on the starting character still means
    // that character: `y$` on the last char of a row yanks it.
    const wentNowhere = sameCaret(origin, m.to);
    if (wentNowhere && !(m.t === "charwise" && m.inclusive)) return null;

    let range: CaretRange;
    if (m.t === "linewise") {
      const [a, b] = orderCarets(origin, m.to);
      range = { kind: "visual-line", start: a, end: b };
    } else {
      const [a, b0] = orderCarets(origin, m.to);
      // Exclusive motions stop one char short of their target. With no
      // newline characters in a text layer, moveLeft is also exactly Vim's
      // "w at the end of a line stops at the end of that word" rule.
      const b = m.inclusive ? b0 : this.moveLeft(b0);
      if (caretBefore(b, a)) return null;
      range = { kind: "visual", start: a, end: b };
    }

    // selectionText() contributes nothing for a page whose spans are not in
    // the DOM yet, so a range reaching into one would yank half of itself
    // and still report success.
    for (let p = range.start.pageIdx; p <= range.end.pageIdx; p++) {
      if (this.getPageSpans(p).length === 0) {
        this.flash("page not rendered — scroll there first", 1200);
        return null;
      }
    }
    return range;
  }

  // --- Text objects ---

  /**
   * Step within the current page only. Text objects must not pull in the
   * next page: moveRight/moveLeft render it on demand, which would scroll
   * the document out from under a `yiw`.
   */
  private stepRightInPage(c: Caret): Caret | null {
    const span = this.spanAt(c);
    if (!span) return null;
    const len = (span.textContent ?? "").length;
    if (c.charOffset + 1 < len) return { ...c, charOffset: c.charOffset + 1 };
    const spans = this.getPageSpans(c.pageIdx);
    if (c.spanIdx + 1 < spans.length) {
      return { pageIdx: c.pageIdx, spanIdx: c.spanIdx + 1, charOffset: 0 };
    }
    return null;
  }

  private stepLeftInPage(c: Caret): Caret | null {
    if (c.charOffset > 0) return { ...c, charOffset: c.charOffset - 1 };
    if (c.spanIdx === 0) return null;
    const spans = this.getPageSpans(c.pageIdx);
    const prev = spans[c.spanIdx - 1];
    const len = (prev?.textContent ?? "").length;
    return {
      pageIdx: c.pageIdx,
      spanIdx: c.spanIdx - 1,
      charOffset: Math.max(0, len - 1),
    };
  }

  /**
   * Does the boundary between two adjacent spans separate two words?
   *
   * It has to be answered geometrically. getPageSpans drops whitespace-only
   * spans, so adjacent spans mean either one word split by a font or kerning
   * run — no visible gap, and treating the seam as a boundary would halve a
   * word — or two words whose separating space was dropped, which shows up
   * as a gap. Academic PDFs produce both, constantly.
   */
  private seamIsGap(left: Caret, right: Caret): boolean {
    if (left.pageIdx !== right.pageIdx) return true;
    if (left.spanIdx === right.spanIdx) return false;
    if (!this.sameRow(left, right)) return true;
    const a = this.caretRect(left);
    const b = this.caretRect(right);
    if (!a || !b) return true;
    const h = Math.max(a.height, b.height) || 1;
    return b.left - a.right > h * SEAM_GAP_RATIO;
  }

  /** Same visual row — the test the rest of this file uses for line breaks. */
  private sameRow(a: Caret, b: Caret): boolean {
    if (a.pageIdx !== b.pageIdx) return false;
    const ra = this.caretRect(a);
    const rb = this.caretRect(b);
    if (!ra || !rb) return false;
    const h = Math.max(ra.height, rb.height) || 1;
    return Math.abs(ra.top - rb.top) <= h * 0.5;
  }

  private caretRect(c: Caret): DOMRect | null {
    const span = this.spanAt(c);
    if (!span) return null;
    return this.charRect(span, c.charOffset) ?? span.getBoundingClientRect();
  }

  /** charKindAt, with punctuation folded into words for WORD objects. */
  private runKindAt(c: Caret, big: boolean): "word" | "punct" | "space" {
    const kind = this.charKindAt(c);
    if (big && kind === "punct") return "word";
    return kind;
  }

  /**
   * The run of same-kind characters under the caret. Text objects are
   * position-independent — "the whole object is operated upon, no matter
   * where on the object the cursor is" — so no forward motion can produce
   * one; this has to scan both ways.
   */
  private runBounds(c: Caret, big: boolean): { start: Caret; end: Caret } | null {
    if (!this.spanAt(c)) return null;
    const kind = this.runKindAt(c, big);
    let start = c;
    let end = c;
    for (;;) {
      const prev = this.stepLeftInPage(start);
      if (!prev || this.runKindAt(prev, big) !== kind) break;
      if (this.seamIsGap(prev, start)) break;
      start = prev;
    }
    for (;;) {
      const next = this.stepRightInPage(end);
      if (!next || this.runKindAt(next, big) !== kind) break;
      if (this.seamIsGap(end, next)) break;
      end = next;
    }
    return { start, end };
  }

  private wordObject(
    c: Caret,
    inner: boolean,
    big: boolean,
    n: number,
  ): CaretRange | null {
    const first = this.runBounds(c, big);
    if (!first) return null;
    const start = first.start;
    let end = first.end;

    if (inner) {
      // `iw` counts runs, whitespace runs included — which is what makes
      // 2iw "word then the space after it" rather than two words.
      for (let i = 1; i < n; i++) {
        const next = this.stepRightInPage(end);
        const run = next ? this.runBounds(next, big) : null;
        if (!run) break;
        end = run.end;
      }
      return { kind: "visual", start, end };
    }

    // One more word, dragging any whitespace separating it from the last one.
    // `aw` counts words, not runs: 2aw is two words, not a word and a gap.
    const nextWordEnd = (from: Caret): Caret | null => {
      const next = this.stepRightInPage(from);
      let run = next ? this.runBounds(next, big) : null;
      if (run && this.runKindAt(run.start, big) === "space") {
        const afterSpace = this.stepRightInPage(run.end);
        run = afterSpace ? this.runBounds(afterSpace, big) : null;
      }
      return run ? run.end : null;
    };

    // Starting on whitespace: that whitespace is included but not counted,
    // so the first counted word is the one after it — and there is no
    // trailing whitespace on this form.
    if (this.runKindAt(c, big) === "space") {
      for (let i = 0; i < n; i++) {
        const next = nextWordEnd(end);
        if (next === null) break;
        end = next;
      }
      return { kind: "visual", start, end };
    }

    for (let i = 1; i < n; i++) {
      const next = nextWordEnd(end);
      if (next === null) break;
      end = next;
    }

    const after = this.stepRightInPage(end);
    if (after && this.sameRow(end, after)) {
      if (!this.seamIsGap(end, after)) {
        if (this.runKindAt(after, big) === "space") {
          const run = this.runBounds(after, big);
          if (run) return { kind: "visual", start, end: run.end };
        }
        // Adjacent with no space at all — "fox." — where Vim takes leading
        // whitespace rather than inventing a trailing one. Fall through.
      } else {
        // A gap with no character in it: pdf.js dropped the whitespace-only
        // span, so the space `aw` promises has to be synthesised.
        return { kind: "visual", start, end, pad: "after" };
      }
    }

    const before = this.stepLeftInPage(start);
    if (before && this.sameRow(before, start)) {
      if (!this.seamIsGap(before, start)) {
        if (this.runKindAt(before, big) === "space") {
          const run = this.runBounds(before, big);
          if (run) return { kind: "visual", start: run.start, end };
        }
      } else {
        return { kind: "visual", start, end, pad: "before" };
      }
    }

    return { kind: "visual", start, end };
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

    // The post-yank flash: operator-pending has no selection to leave
    // behind, so paint the operated range briefly to show what was taken.
    // It lives in render() rather than being painted once because
    // vim-controller re-renders on `pagerendered`, which wipes every overlay.
    if (this.flashRange && this.kind === "insert") {
      this.renderSelection(this.flashRange);
    }

    const sel = this.currentRange();
    if (sel) this.renderSelection(sel);
  }

  /** The live visual selection, if there is one. */
  private currentRange(): CaretRange | null {
    if (!this.caret || !this.anchor || this.kind === "insert" || this.kind === "off") {
      return null;
    }
    return { kind: this.kind, start: this.anchor, end: this.caret };
  }

  // --- Rendering helpers ---

  private renderSelection(r: CaretRange): void {
    const a = r.start;
    const b = r.end;
    if (r.kind === "visual-block") {
      this.renderBlockSelection(r);
      return;
    }

    let [s, end] = orderCarets(a, b);
    if (r.kind === "visual-line") {
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
        if (r.kind === "visual") {
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

  private renderBlockSelection(r: CaretRange): void {
    const a = r.start;
    const b = r.end;
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
    const pageRect = pageFrameRect(pageEl);
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
   *   1. If a link/outline/find jump just happened *and its landing point is
   *      still visible in the viewport*, land at the destination anchor.
   *      The visibility check matters: the jump dest is recorded on every
   *      programmatic navigation and isn't cleared on manual scroll, so
   *      without it a stale dest from an earlier jump would make `i` yank
   *      the viewport back to that old location.
   *      Uses the jump's own pageIdx rather than viewer.currentPage —
   *      PDF.js reports currentPageNumber as the page occupying most of
   *      the viewport, which for top-of-viewport citation jumps is often
   *      the *next* page visible below.
   *   2. Otherwise, pick the visible span closest to the viewport top.
   */
  private findStartCaret(): Caret | null {
    const jump = this.viewer.resolveJumpDestClient();
    if (jump) {
      if (this.isJumpDestCurrent(jump)) {
        const jumpSpans = this.getPageSpans(jump.pageIdx);
        if (jumpSpans.length > 0) {
          const idx = this.closestSpanTo(
            jumpSpans,
            jump.clientX,
            jump.clientY,
          );
          this.viewer.clearJumpDest();
          if (idx >= 0) {
            return { pageIdx: jump.pageIdx, spanIdx: idx, charOffset: 0 };
          }
        }
      } else {
        // Stale — drop it so subsequent `i` presses don't keep referencing
        // a destination the user has already scrolled away from.
        this.viewer.clearJumpDest();
      }
    }

    const pageIdx = this.viewer.currentPage - 1;
    const spans = this.getPageSpans(pageIdx);
    if (spans.length === 0) return null;

    // Drop the caret near the visual center of the viewport — landing at
    // the top-left is disorienting when entering insert/caret mode from a
    // scrolled-into-place reading position. Y is weighted double so we
    // pick the right line first, then break ties with X to get a span
    // close to the horizontal center.
    const cRect = this.viewer.container.getBoundingClientRect();
    const targetX = (cRect.left + cRect.right) / 2;
    const targetY = (cRect.top + cRect.bottom) / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < spans.length; i++) {
      const r = spans[i].getBoundingClientRect();
      if (r.bottom <= cRect.top) continue;
      if (r.top >= cRect.bottom) continue;
      const dy =
        Math.max(0, r.top - targetY) + Math.max(0, targetY - r.bottom);
      const dx =
        Math.max(0, r.left - targetX) + Math.max(0, targetX - r.right);
      const d = dy * 2 + dx;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return { pageIdx, spanIdx: bestIdx >= 0 ? bestIdx : 0, charOffset: 0 };
  }

  /**
   * Is the recorded jump destination still "here"? We accept the jump when
   * the landing Y is inside (or just outside) the viewport, or — for dests
   * that carry no Y (Fit) — when the target page is adjacent to the
   * currently-viewed page. A small vertical slack handles the case where a
   * citation anchor is a handful of pixels above the top fold.
   */
  private isJumpDestCurrent(jump: {
    pageIdx: number;
    clientX: number | null;
    clientY: number | null;
  }): boolean {
    const cRect = this.viewer.container.getBoundingClientRect();
    if (jump.clientY !== null) {
      const SLACK = 80;
      return (
        jump.clientY >= cRect.top - SLACK &&
        jump.clientY <= cRect.bottom + SLACK
      );
    }
    return Math.abs(this.viewer.currentPage - 1 - jump.pageIdx) <= 1;
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
  private wordNext(c: Caret, big = false): Caret {
    const startKind = this.runKindAt(c, big);
    let cur = c;
    // Skip the rest of the current run.
    while (true) {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      if (this.runKindAt(next, big) !== startKind) { cur = next; break; }
      cur = next;
    }
    // Skip whitespace until we hit the next word/punct run.
    while (this.runKindAt(cur, big) === "space") {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      cur = next;
    }
    return cur;
  }

  /**
   * Vim `b`: back to the start of the current or previous word.
   */
  private wordPrev(c: Caret, big = false): Caret {
    let cur = this.moveLeft(c);
    if (sameCaret(cur, c)) return c;
    while (this.runKindAt(cur, big) === "space") {
      const prev = this.moveLeft(cur);
      if (sameCaret(prev, cur)) return cur;
      cur = prev;
    }
    const kind = this.runKindAt(cur, big);
    while (true) {
      const prev = this.moveLeft(cur);
      if (sameCaret(prev, cur)) return cur;
      if (this.runKindAt(prev, big) !== kind) return cur;
      cur = prev;
    }
  }

  /**
   * Vim `e`: advance to the last char of the current or next word.
   */
  private wordEnd(c: Caret, big = false): Caret {
    let cur = this.moveRight(c);
    if (sameCaret(cur, c)) return c;
    while (this.runKindAt(cur, big) === "space") {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      cur = next;
    }
    const kind = this.runKindAt(cur, big);
    while (true) {
      const next = this.moveRight(cur);
      if (sameCaret(next, cur)) return cur;
      if (this.runKindAt(next, big) !== kind) return cur;
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

  private async yankSelection(
    r: CaretRange,
  ): Promise<"copied" | "empty" | "failed"> {
    const base = this.selectionText(r);
    // The pad goes on here, never inside selectionText(): that ends in
    // .trim(), which would eat it again.
    const text =
      r.pad === "after" ? `${base} ` : r.pad === "before" ? ` ${base}` : base;
    if (!text) {
      this.viewer.setStatusCenter("empty selection");
      setTimeout(() => this.viewer.clearStatusCenter(), 1000);
      return "empty";
    }
    const ok = await copyText(text);
    this.viewer.setStatusCenter(
      ok ? `yanked ${text.length} chars` : "yank failed (clipboard blocked)",
    );
    setTimeout(() => this.viewer.clearStatusCenter(), 1200);
    return ok ? "copied" : "failed";
  }

  private selectionText(r: CaretRange): string {
    if (r.kind === "visual-block") {
      return this.blockSelectionText(r);
    }

    let [s, end] = orderCarets(r.start, r.end);
    if (r.kind === "visual-line") {
      s = this.lineStart(s);
      end = this.lineEnd(end);
    }

    const lines: string[][] = [];
    let currentLine: string[] = [];
    let lastTop: number | null = null;
    let lastHeight = 0;
    let lastRight = 0;

    for (let p = s.pageIdx; p <= end.pageIdx; p++) {
      const spans = this.getPageSpans(p);
      const from = p === s.pageIdx ? s.spanIdx : 0;
      const to = p === end.pageIdx ? end.spanIdx : spans.length - 1;
      for (let i = from; i <= to; i++) {
        const span = spans[i];
        const txt = span.textContent ?? "";
        let a = 0;
        let b = txt.length;
        if (r.kind === "visual") {
          if (p === s.pageIdx && i === s.spanIdx) a = s.charOffset;
          if (p === end.pageIdx && i === end.spanIdx)
            b = Math.min(txt.length, end.charOffset + 1);
        }
        const piece = txt.slice(a, b);
        if (!piece) continue;
        const rect = this.charRangeRect(span, a, b) ?? span.getBoundingClientRect();
        if (lastTop !== null && Math.abs(rect.top - lastTop) > lastHeight * 0.5) {
          lines.push(currentLine);
          currentLine = [];
        } else if (currentLine.length) {
          // Whether a space belongs at a span boundary is the same question
          // seamIsGap answers for text objects, and it has to be answered the
          // same way here or the two disagree: a gap means pdf.js dropped a
          // whitespace-only span, while no gap means one word split by a
          // kerning run — where a space would cut the word in half.
          const h = Math.max(rect.height, lastHeight) || 1;
          currentLine.push(rect.left - lastRight > h * SEAM_GAP_RATIO ? " " : "");
        }
        currentLine.push(piece);
        lastTop = rect.top;
        lastHeight = rect.height;
        lastRight = rect.right;
      }
    }
    if (currentLine.length) lines.push(currentLine);
    // join("") — the separators were decided per seam above.
    return lines.map((parts) => parts.join("")).join("\n").trim();
  }

  private blockSelectionText(r: CaretRange): string {
    if (r.end.pageIdx !== r.start.pageIdx) return "";
    const pageIdx = r.end.pageIdx;
    const aSpan = this.spanAt(r.start);
    const bSpan = this.spanAt(r.end);
    if (!aSpan || !bSpan) return "";
    const aR = this.charRect(aSpan, r.start.charOffset) ?? aSpan.getBoundingClientRect();
    const bR = this.charRect(bSpan, r.end.charOffset) ?? bSpan.getBoundingClientRect();
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

  private async highlightSelection(r: CaretRange): Promise<void> {
    const rects = this.selectionHighlightRects(r);
    if (rects.length === 0) return;
    const hl: Highlight = {
      id: Math.random().toString(36).slice(2, 10),
      color: this.highlightColor(),
      rects,
    };
    await this.viewer.addHighlight(hl);
  }

  // Snapshot the accent color at creation time so saved highlights remain
  // stable even if the user later changes the accent setting.
  private highlightColor(): string {
    const raw = (this.viewer.settings.accentColor ?? "").trim();
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (!m) return "rgba(255, 90, 60, 0.4)";
    const s =
      m[1].length === 3
        ? m[1].split("").map((c) => c + c).join("")
        : m[1];
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0.4)`;
  }

  private selectionHighlightRects(r: CaretRange): HighlightRect[] {
    const out: HighlightRect[] = [];

    if (r.kind === "visual-block") {
      if (r.end.pageIdx !== r.start.pageIdx) return [];
      const pageIdx = r.end.pageIdx;
      const pageEl = this.pageElement(pageIdx);
      if (!pageEl) return [];
      const refRect = this.highlightRefRect(pageEl);
      const aSpan = this.spanAt(r.start);
      const bSpan = this.spanAt(r.end);
      if (!aSpan || !bSpan) return [];
      const aR = this.charRect(aSpan, r.start.charOffset) ?? aSpan.getBoundingClientRect();
      const bR = this.charRect(bSpan, r.end.charOffset) ?? bSpan.getBoundingClientRect();
      const left = Math.min(aR.left, bR.left);
      const right = Math.max(aR.right, bR.right);
      const top = Math.min(aR.top, bR.top);
      const bottom = Math.max(aR.bottom, bR.bottom);
      for (const span of this.getPageSpans(pageIdx)) {
        const rect = span.getBoundingClientRect();
        if (rect.right < left || rect.left > right) continue;
        if (rect.bottom < top || rect.top > bottom) continue;
        const ol = Math.max(left, rect.left);
        const or = Math.min(right, rect.right);
        const ot = Math.max(top, rect.top);
        const ob = Math.min(bottom, rect.bottom);
        if (or <= ol || ob <= ot) continue;
        out.push({
          pageIndex: pageIdx,
          x: (ol - refRect.left) / refRect.width,
          y: (ot - refRect.top) / refRect.height,
          w: (or - ol) / refRect.width,
          h: (ob - ot) / refRect.height,
        });
      }
      return out;
    }

    let [s, end] = orderCarets(r.start, r.end);
    if (r.kind === "visual-line") {
      s = this.lineStart(s);
      end = this.lineEnd(end);
    }
    for (let p = s.pageIdx; p <= end.pageIdx; p++) {
      const pageEl = this.pageElement(p);
      if (!pageEl) continue;
      const refRect = this.highlightRefRect(pageEl);
      const spans = this.getPageSpans(p);
      const from = p === s.pageIdx ? s.spanIdx : 0;
      const to = p === end.pageIdx ? end.spanIdx : spans.length - 1;
      for (let i = from; i <= to; i++) {
        const span = spans[i];
        const len = (span.textContent ?? "").length;
        let a = 0;
        let b = len;
        if (r.kind === "visual") {
          if (p === s.pageIdx && i === s.spanIdx) a = s.charOffset;
          if (p === end.pageIdx && i === end.spanIdx)
            b = Math.min(len, end.charOffset + 1);
        }
        const rect = this.charRangeRect(span, a, b);
        if (!rect) continue;
        out.push({
          pageIndex: p,
          x: (rect.left - refRect.left) / refRect.width,
          y: (rect.top - refRect.top) / refRect.height,
          w: rect.width / refRect.width,
          h: rect.height / refRect.height,
        });
      }
    }
    return out;
  }

  private highlightRefRect(pageEl: HTMLElement): DOMRect {
    return pageFrameRect(pageEl);
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

/** Strict document order — used to spot a range that shrank past its start. */
function caretBefore(a: Caret, b: Caret): boolean {
  if (a.pageIdx !== b.pageIdx) return a.pageIdx < b.pageIdx;
  if (a.spanIdx !== b.spanIdx) return a.spanIdx < b.spanIdx;
  return a.charOffset < b.charOffset;
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
  const pageRect = pageFrameRect(pageEl);
  const box = document.createElement("div");
  box.className = className;
  box.style.position = "absolute";
  box.style.left = `${((r.left - pageRect.left) / pageRect.width) * 100}%`;
  box.style.top = `${((r.top - pageRect.top) / pageRect.height) * 100}%`;
  box.style.width = `${(r.width / pageRect.width) * 100}%`;
  box.style.height = `${(r.height / pageRect.height) * 100}%`;
  return box;
}

/**
 * Reference frame for converting viewport rects → page-relative percentages.
 * Overlays are appended as `position: absolute` children of `.page`, so their
 * `%` sizes resolve against `.page`'s padding-box (inside its 1px border).
 * `.page.getBoundingClientRect()` returns the *border-box* — using it would
 * drift ~1px per edge, amplified by zoom and visible on wide figures.
 * `.textLayer` sits at `inset: 0` inside `.page`, sharing the padding-box
 * frame, so it's a reliable proxy.
 */
function pageFrameRect(pageEl: HTMLElement): DOMRect {
  const textLayer = pageEl.querySelector(".textLayer") as HTMLElement | null;
  return (textLayer ?? pageEl).getBoundingClientRect();
}
