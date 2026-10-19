import type { Viewer } from "./viewer";
import type { Pane } from "./pane";
import type { MarksStore } from "./marks";
import type { SearchController } from "./search";
import type { Settings } from "../common/settings";
import {
  activateFocusedOutline,
  clearOutlineFocus,
  collapseFocusedOutline,
  expandFocusedOutline,
  focusCurrentSection,
  focusFirstOutlineItem,
  hasOutlineItems,
  isOutlineFocusActive,
  focusLastOutlineItem,
  isSidebarOpen,
  moveOutlineFocus,
  moveOutlineFocusPage,
  outlineFold,
  type FoldOp,
  toggleSidebar,
} from "./outline";
import { ContinuousScroll } from "./continuous-scroll";
import { HintController } from "./hints";
import { JumpList, type JumpPos } from "./jump-list";
import { CaretMode } from "./caret-mode";
import { Finder } from "./finder";
import { CommandLine } from "./cmdline";
import { RefPane, type SplitDirection } from "./ref-pane";

type Mode = "normal" | "search" | "hint" | "finder" | "command";
type ScrollKey = "j" | "k" | "h" | "l";

export class VimController {
  private mode: Mode = "normal";

  // Multi-key buffers
  private pendingCount = "";
  private pendingG = false;
  private pendingMark: "set" | "jump" | null = null;
  private pendingZ = false;
  private pendingOutlineG = false;
  // Ctrl-w (or W) was pressed; the next key is a window command.
  private pendingWindow = false;
  // The key that finished a window command, whose auto-repeats are
  // swallowed: holding the `x` of `W x` must not go on to close the tab.
  private windowRepeatKey: string | null = null;

  private scroller: ContinuousScroll;
  private hints: HintController;
  private cmdline: CommandLine;
  // One jump list per pane, as Vim keeps one per window: Ctrl-O in the
  // reference pane walks back through that pane's own jumps.
  private jumpLists = new Map<Pane, JumpList>();
  private caretMode: CaretMode;
  private finder: Finder;
  private ref: RefPane;
  private refFocused = false;

  constructor(
    private viewer: Viewer,
    private marks: MarksStore,
    private search: SearchController,
  ) {
    this.ref = new RefPane(viewer);
    this.scroller = new ContinuousScroll(() => this.pane.container);
    this.hints = new HintController();
    this.cmdline = new CommandLine(
      (cmd) => this.runCommand(cmd),
      () => {
        this.mode = "normal";
        this.pane.container.focus();
      },
    );
    this.caretMode = new CaretMode(viewer, () => this.pane);
    this.finder = new Finder(viewer, marks, {
      recordJump: () => this.jumps.record(this.snapshot()),
      getPane: () => this.pane,
      getHighlights: () => viewer.highlights,
      onClose: () => {
        this.mode = "normal";
        this.pane.container.focus();
      },
    });
    // Only the caret's own pane: render() scrolls the caret into view, and
    // the other pane rendering must not pull it back.
    viewer.eventBus.on("pagerendered", () => {
      if (this.pane === this.viewer) this.caretMode.render();
    });
    this.ref.eventBus.on("pagerendered", () => {
      if (this.pane === this.ref) this.caretMode.render();
    });
  }

  /**
   * The pane that motions, zoom, marks and finder jumps act on. Caret mode,
   * search, link hints, the outline and the jump list always use the main
   * pane; keys for those move focus back to it first.
   */
  private get pane(): Pane {
    // The split can also close underneath us (a dropped file replaces the
    // document), so don't trust the flag alone.
    return this.refFocused && this.ref.isOpen ? this.ref : this.viewer;
  }

  updateSettings(_settings: Settings): void {
    // Scroll/zoom steps are read live from viewer.settings.
    // Left as a hook for future settings that affect controller-local state.
  }

  attach(): void {
    document.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("keyup", this.onKeyUp, true);
    // Stop continuous scroll if window loses focus (e.g. Cmd+Tab) since we
    // won't get a keyup.
    window.addEventListener("blur", () => this.scroller.stop());

    const help = document.getElementById("help");
    help?.addEventListener("click", (e) => {
      if (e.target === help) this.toggleHelp();
    });

    // Forward / to search; search handles its own Esc/Enter via SearchController.
    const searchInput = document.getElementById(
      "searchInput",
    ) as HTMLInputElement | null;
    searchInput?.addEventListener("keydown", this.onSearchKeyDown);
    searchInput?.addEventListener("input", () => {
      this.search.queryChanged(searchInput.value);
    });

    for (const pane of [this.viewer, this.ref] as Pane[]) {
      // Trackpad pinch + Ctrl/Cmd+wheel: route through PDF.js zoom rather
      // than browser page-zoom, which has its own floor and drifts out of
      // sync with the PDF.js scale.
      pane.container.addEventListener(
        "wheel",
        (e: WheelEvent) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.01);
          pane.zoomBy(factor);
        },
        { passive: false },
      );
      // Clicking into a pane focuses it, as in Vim with the mouse enabled.
      pane.container.addEventListener("mousedown", () => {
        if (this.ref.isOpen && pane !== this.pane) {
          this.focusPane(pane === this.ref ? "ref" : "main");
        }
      });
    }

    // Keep viewer focused so keydowns land on document, not a stray element.
    this.viewer.container.focus();
  }

  // --- handlers ---

  private onSearchKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.exitSearch({ clear: true });
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.search.commit();
      this.exitSearch({ clear: false });
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const key = e.key;

    // If the user is typing into any form input (save dialog, finder,
    // search, help filter…), stay out of the way entirely. Our capture-phase
    // listener otherwise intercepts keys before they can reach the input —
    // e.g. caret-mode would turn a `v` inside the save dialog into a visual-
    // mode toggle, and Cmd+V paste would never land in the field. Dedicated
    // inputs handle their own Esc/Enter; everything else is a pass-through.
    const target = e.target as Element | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      this.pendingZ = false;
      this.pendingOutlineG = false;
      this.pendingWindow = false;
      this.windowRepeatKey = null;
      return;
    }

    if (this.windowRepeatKey !== null) {
      if (e.repeat && key.toLowerCase() === this.windowRepeatKey) {
        e.preventDefault();
        return;
      }
      this.windowRepeatKey = null;
    }

    // The key after Ctrl-w / W. Checked this early because the second key
    // is often a Ctrl combo too (Ctrl-w Ctrl-s must split, not download),
    // and the outline and caret blocks below would read `w`, `v`, `s`… as
    // their own commands.
    if (this.pendingWindow) {
      if (
        key === "Shift" ||
        key === "Control" ||
        key === "Alt" ||
        key === "Meta"
      ) {
        return;
      }
      e.preventDefault();
      // A held W / Ctrl-w repeats itself; that is not the second key.
      if (e.repeat) return;
      this.pendingWindow = false;
      this.windowRepeatKey = key.toLowerCase();
      this.windowCommand(key);
      return;
    }

    // Download / Print — intercept browser defaults (Save Page As / Print
    // dialog targeting the viewer UI) and drive PDF-aware flows instead.
    // Matches normal PDF viewers: Ctrl/Cmd+S saves the PDF bytes, Ctrl/Cmd+P
    // prints the rendered pages.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const lk = key.toLowerCase();
      // These return before the outline block, which otherwise consumes an
      // armed z prefix — without the reset, the key after a z, Cmd+S
      // detour would silently run as a fold command.
      if (lk === "s") {
        this.pendingZ = false;
        this.pendingOutlineG = false;
        e.preventDefault();
        void this.viewer.download();
        return;
      }
      if (lk === "p") {
        this.pendingZ = false;
        this.pendingOutlineG = false;
        e.preventDefault();
        void this.viewer.print();
        return;
      }
    }

    // Help overlay: supports Vim-style scroll (j/k/Ctrl-d/u/gg/G) and an
    // inline "/" filter for the bindings table.
    if (this.isHelpOpen()) {
      if (this.handleHelpKey(e)) return;
      return;
    }

    if (this.mode === "hint") {
      this.hints.handleKey(e);
      return;
    }

    if (this.mode === "search") return; // search input owns events
    if (this.mode === "finder") return; // finder input owns events
    if (this.mode === "command") return; // command-line input owns events

    // Ctrl-w starts a window command, in any mode. Chrome reserves Ctrl-W
    // for closing the tab on Windows and Linux, so the page never sees it
    // there; `W` in normal mode is the portable spelling.
    if (
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      key.toLowerCase() === "w"
    ) {
      e.preventDefault();
      this.armWindowPrefix();
      return;
    }

    // vim-tmux-navigator style: Ctrl-{h,j,k,l} is Ctrl-w {h,j,k,l} without
    // the prefix. Checked before the main-pane gate, which would otherwise
    // send the ref pane's Ctrl-h into the outline. Claimed only when focus
    // actually moves, so with no pane that way Chrome keeps Ctrl-L / Ctrl-J /
    // Ctrl-H / Ctrl-K on Windows and Linux, and a scroll alias recorded as
    // e.g. "Ctrl+j" still wins. Caret mode and a focused outline keep their
    // own Ctrl-h / Ctrl-l; Ctrl-w still switches panes from there.
    if (
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      "hjkl".includes(key.toLowerCase()) &&
      key.length === 1 &&
      this.pendingMark === null &&
      !this.pendingG &&
      !this.caretMode.isActive &&
      !isOutlineFocusActive() &&
      !this.matchesScrollAlias(e)
    ) {
      const target = this.paneToward(key.toLowerCase());
      if (target && target !== (this.refFocused ? "ref" : "main")) {
        e.preventDefault();
        // A count typed before the switch belongs to neither pane.
        this.pendingCount = "";
        this.pendingZ = false;
        this.focusPane(target);
        return;
      }
    }

    // Features that only the main pane has. From the reference pane, move
    // focus back first so `/`, `n`, `o`… act on the pane they belong to.
    // Not while a mark or g prefix waits for its second key: `mf` sets
    // mark f, it doesn't start a search. Nor during caret mode, which takes
    // these keys itself; switching panes would exit it and drop a visual
    // selection.
    if (
      this.refFocused &&
      !this.caretMode.isActive &&
      this.pendingMark === null &&
      !this.pendingG &&
      isMainPaneKey(e)
    ) {
      this.focusPane("main");
    }

    // Outline navigation takes priority over caret mode so j/k/Enter can steer
    // the sidebar even while caret insert/visual is active.
    if (isOutlineFocusActive()) {
      // Bare modifier presses must not clear focus or break the z prefix
      // (`zM` arrives as z, Shift, M).
      if (
        key === "Shift" ||
        key === "Control" ||
        key === "Alt" ||
        key === "Meta"
      ) {
        return;
      }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      if (this.pendingOutlineG) {
        this.pendingOutlineG = false;
        if (plain && key === "g") {
          e.preventDefault();
          focusFirstOutlineItem();
          return;
        }
      }
      if (this.pendingZ) {
        this.pendingZ = false;
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          key.length === 1 &&
          "aocAOCmrMR".includes(key)
        ) {
          e.preventDefault();
          outlineFold(key as FoldOp);
          return;
        }
      }
      if (key === "j" || (plain && key === "ArrowDown")) {
        e.preventDefault();
        moveOutlineFocus(1);
        return;
      }
      if (key === "k" || (plain && key === "ArrowUp")) {
        e.preventDefault();
        moveOutlineFocus(-1);
        return;
      }
      if (plain && (key === "l" || key === "ArrowRight")) {
        e.preventDefault();
        expandFocusedOutline();
        return;
      }
      if (plain && (key === "h" || key === "ArrowLeft")) {
        e.preventDefault();
        collapseFocusedOutline();
        return;
      }
      if (plain && key === "z") {
        e.preventDefault();
        this.pendingZ = true;
        return;
      }
      // `o` with focus always closes; opening / refocusing an unfocused
      // outline is handled by the two `o` handlers further down.
      if (plain && key === "o") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (plain && key === "g") {
        e.preventDefault();
        this.pendingOutlineG = true;
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey && key === "G") {
        e.preventDefault();
        focusLastOutlineItem();
        return;
      }
      // Page movement stays inside the outline — scrolling the document
      // out from under the focus breaks the "I'm in the outline" model.
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const lk = key.toLowerCase();
        if (lk === "d" || lk === "u") {
          e.preventDefault();
          moveOutlineFocusPage(lk === "d" ? 1 : -1, false);
          return;
        }
        if (lk === "f" || lk === "b") {
          e.preventDefault();
          moveOutlineFocusPage(lk === "f" ? 1 : -1, true);
          return;
        }
      }
      if (key === "Enter") {
        e.preventDefault();
        activateFocusedOutline();
        clearOutlineFocus();
        if (this.caretMode.isInsert) {
          requestAnimationFrame(() => this.caretMode.reseed());
        }
        return;
      }
      // With a split open, Ctrl-l too: the outline sits left of the main
      // pane, so moving right lands there, not on the pane beyond it.
      // Without one, Ctrl-l stays Chrome's (or a scroll alias's).
      const ctrlL =
        e.ctrlKey && !e.shiftKey && !e.altKey && key.toLowerCase() === "l" &&
        this.ref.isOpen && !this.matchesScrollAlias(e);
      if (
        key === "Escape" ||
        (e.ctrlKey && !e.shiftKey && !e.altKey && key.toLowerCase() === "h") ||
        ctrlL
      ) {
        e.preventDefault();
        clearOutlineFocus();
        return;
      }
      // After the built-ins, so an alias recorded as e.g. "Ctrl+h" can't
      // shadow the focus-release above.
      if (matchesAlias(e, this.viewer.settings.halfPageDownKey)) {
        e.preventDefault();
        moveOutlineFocusPage(1, false);
        return;
      }
      if (matchesAlias(e, this.viewer.settings.halfPageUpKey)) {
        e.preventDefault();
        moveOutlineFocusPage(-1, false);
        return;
      }
      if (matchesAlias(e, this.viewer.settings.fullPageDownKey)) {
        e.preventDefault();
        moveOutlineFocusPage(1, true);
        return;
      }
      if (matchesAlias(e, this.viewer.settings.fullPageUpKey)) {
        e.preventDefault();
        moveOutlineFocusPage(-1, true);
        return;
      }
      clearOutlineFocus();
      // fall through to caret / normal handling
    }

    if (this.caretMode.isActive) {
      // Let the jump-list navigate even inside insert mode — useful after
      // following a citation link. Visual modes are left alone so the
      // anchor isn't lost, and so is a pending operator: Ctrl-O with `y`
      // armed must reach caret mode, which aborts it, rather than jumping
      // the caret out from under the motion the operator is waiting for.
      if (this.caretMode.isInsert && !this.caretMode.isOperatorPending) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          const lk = key.toLowerCase();
          if (lk === "o") {
            e.preventDefault();
            this.jumpBack();
            requestAnimationFrame(() => this.caretMode.reseed());
            return;
          }
          if (lk === "i") {
            e.preventDefault();
            this.jumpForward();
            requestAnimationFrame(() => this.caretMode.reseed());
            return;
          }
        }
        if (key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          this.jumpForward();
          requestAnimationFrame(() => this.caretMode.reseed());
          return;
        }
        // Plain `o` toggles the sidebar (auto-focusing the current section)
        // without leaving caret insert. Only an unfocused outline reaches
        // here — the outline block above closes on focused `o` — so the
        // "refocus" option means: skip the toggle, take back the focus.
        if (key === "o" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          // The outline drives the main pane; from the reference pane, go
          // there first (which ends this caret) rather than reseed a caret
          // in a pane the outline doesn't move.
          if (this.pane === this.ref) this.focusPane("main");
          const refocus =
            this.viewer.settings.outlineOBehavior === "refocus" &&
            isSidebarOpen() &&
            hasOutlineItems();
          if (!refocus) toggleSidebar();
          if (isSidebarOpen() && hasOutlineItems()) {
            if (!focusCurrentSection(this.viewer.currentPage)) {
              focusFirstOutlineItem();
            }
          }
          return;
        }
      }
      this.caretMode.handleKey(e);
      return;
    }

    // Enter outline-nav with Ctrl-h when sidebar is open (non-caret path).
    if (
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      key.toLowerCase() === "h"
    ) {
      if (isSidebarOpen() && hasOutlineItems()) {
        e.preventDefault();
        if (!focusCurrentSection(this.viewer.currentPage)) {
          focusFirstOutlineItem();
        }
        return;
      }
    }

    // Pending 'm' — set mark
    if (this.pendingMark === "set") {
      this.pendingMark = null;
      if (/^[a-zA-Z]$/.test(key)) {
        e.preventDefault();
        const anchor = this.pane.captureMarkAnchor();
        if (anchor) {
          this.marks.set(key, anchor);
          this.viewer.setStatusCenter(`mark ${key} set`);
          setTimeout(() => this.viewer.clearStatusCenter(), 1200);
        }
      }
      return;
    }

    // Pending ' — jump to mark
    if (this.pendingMark === "jump") {
      this.pendingMark = null;
      if (/^[a-zA-Z]$/.test(key)) {
        e.preventDefault();
        const m = this.marks.get(key);
        if (m) {
          this.pane.restoreMarkAnchor(m);
        } else {
          this.viewer.setStatusCenter(`mark ${key} not set`);
          setTimeout(() => this.viewer.clearStatusCenter(), 1200);
        }
      }
      return;
    }

    // g{g,0,$} sequences. `g0`/`g$` jump to first/last tab (Vimium parity);
    // `gt`/`gT` are intentionally NOT bound because `T` is already the fuzzy
    // finder — `J`/`K` cover next/prev tab without that ambiguity.
    if (this.pendingG) {
      this.pendingG = false;
      if (key === "g") {
        e.preventDefault();
        this.pane.goToPage(1);
        return;
      }
      if (key === "0") {
        e.preventDefault();
        this.sendTabCommand("first");
        return;
      }
      if (key === "$") {
        e.preventDefault();
        this.sendTabCommand("last");
        return;
      }
      // fall through — g was not followed by a recognised key
    }

    // Count prefix for {n}G
    if (/^[0-9]$/.test(key) && !(key === "0" && this.pendingCount === "")) {
      // Reserve lone "0" for zoom reset; once a count is started, 0 is digit.
      e.preventDefault();
      this.pendingCount += key;
      return;
    }

    const count = this.pendingCount ? parseInt(this.pendingCount, 10) : 0;
    this.pendingCount = "";

    // Ctrl combos
    if (e.ctrlKey && !e.shiftKey && !e.altKey) {
      switch (key.toLowerCase()) {
        case "d":
          e.preventDefault();
          this.pane.scrollHalfPage(1);
          return;
        case "u":
          e.preventDefault();
          this.pane.scrollHalfPage(-1);
          return;
        case "f":
          e.preventDefault();
          this.pane.scrollFullViewport(1);
          return;
        case "b":
          e.preventDefault();
          this.pane.scrollFullViewport(-1);
          return;
        case "o":
          e.preventDefault();
          this.jumpBack();
          return;
        case "i":
          e.preventDefault();
          this.jumpForward();
          return;
      }
    }

    // Tab is the traditional partner of Ctrl-O (same keycode), handle it too.
    if (key === "Tab" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.jumpForward();
      return;
    }

    const s = this.viewer.settings;

    // User-defined aliases for the Ctrl-{d,u,f,b} page scrolls.
    // Accepts plain keys (e.g. "d", " ") or modifier combos (e.g. "Alt+j").
    if (matchesAlias(e, s.halfPageDownKey)) {
      e.preventDefault();
      this.pane.scrollHalfPage(1);
      return;
    }
    if (matchesAlias(e, s.halfPageUpKey)) {
      e.preventDefault();
      this.pane.scrollHalfPage(-1);
      return;
    }
    if (matchesAlias(e, s.fullPageDownKey)) {
      e.preventDefault();
      this.pane.scrollFullViewport(1);
      return;
    }
    if (matchesAlias(e, s.fullPageUpKey)) {
      e.preventDefault();
      this.pane.scrollFullViewport(-1);
      return;
    }

    // Plain-key bindings below: skip if Ctrl / Meta (Cmd) / Alt is held so
    // browser and system shortcuts (Cmd+O open file, Cmd+F find, Cmd+T new
    // tab, Cmd+± / Cmd+0 zoom, ...) pass through untouched. Shift is
    // allowed — it's how we get T / J / K / H / L / G / N from their
    // lowercase counterparts. Modifier combos that VimDF *does* want
    // (Ctrl-{d,u,f,b,o,i}, user-defined aliases) are matched earlier in
    // this function and `return` before reaching here.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (key) {
      case "j":
        e.preventDefault();
        this.handleScroll(e, "j", "y", 1, s.scrollStep);
        return;
      case "k":
        e.preventDefault();
        this.handleScroll(e, "k", "y", -1, s.scrollStep);
        return;
      case "h":
        e.preventDefault();
        this.handleScroll(e, "h", "x", -1, s.hScrollStep);
        return;
      case "l":
        e.preventDefault();
        this.handleScroll(e, "l", "x", 1, s.hScrollStep);
        return;

      case "g":
        e.preventDefault();
        this.pendingG = true;
        return;
      case "G":
        e.preventDefault();
        this.pane.goToPage(count > 0 ? count : this.viewer.numPages);
        return;

      case "+":
      case "=":
        e.preventDefault();
        this.pane.zoomIn();
        return;
      case "-":
        e.preventDefault();
        this.pane.zoomOut();
        return;
      case "0":
        e.preventDefault();
        this.pane.fitWidth();
        return;

      case "W":
        e.preventDefault();
        this.armWindowPrefix();
        return;

      case "T":
        e.preventDefault();
        this.openFinder();
        return;

      case "J":
        e.preventDefault();
        this.sendTabCommand(this.viewer.settings.swapTabDirection ? "next" : "prev");
        return;
      case "K":
        e.preventDefault();
        this.sendTabCommand(this.viewer.settings.swapTabDirection ? "prev" : "next");
        return;
      case "H":
        e.preventDefault();
        this.sendTabCommand("back");
        return;
      case "L":
        e.preventDefault();
        this.sendTabCommand("forward");
        return;
      case "t":
        e.preventDefault();
        this.sendTabCommand("new");
        return;
      case "x":
        e.preventDefault();
        this.sendTabCommand("close");
        return;

      case "o": {
        // Only an unfocused outline reaches here (the outline block closes
        // on focused `o`); the "refocus" option skips the toggle and takes
        // back the focus instead.
        e.preventDefault();
        const refocus =
          s.outlineOBehavior === "refocus" &&
          isSidebarOpen() &&
          hasOutlineItems();
        if (!refocus) toggleSidebar();
        if (isSidebarOpen() && hasOutlineItems()) {
          if (!focusCurrentSection(this.viewer.currentPage)) {
            focusFirstOutlineItem();
          }
        }
        return;
      }

      case ":":
        e.preventDefault();
        this.mode = "command";
        this.cmdline.open();
        return;

      case "?":
        e.preventDefault();
        this.toggleHelp();
        return;

      case "m":
        e.preventDefault();
        this.pendingMark = "set";
        return;
      case "'":
      case "`":
        e.preventDefault();
        this.pendingMark = "jump";
        return;

      case "f":
      case "F":
        e.preventDefault();
        this.enterHint(key === "F");
        return;

      case "i":
        e.preventDefault();
        this.caretMode.enterInsert();
        return;

      case "/":
        e.preventDefault();
        this.enterSearch();
        return;
      case "n":
        e.preventDefault();
        this.search.next();
        return;
      case "N":
        e.preventDefault();
        this.search.prev();
        return;

      case "Escape":
        this.viewer.findStatusEnabled = false;
        this.viewer.clearStatusCenter();
        this.pendingCount = "";
        this.pendingG = false;
        this.pendingMark = null;
        this.search.clear();
        return;
    }
  };

  // --- Windows (split view) ---

  private armWindowPrefix(): void {
    this.pendingWindow = true;
    this.pendingCount = "";
    this.pendingG = false;
    this.pendingMark = null;
    this.pendingZ = false;
    this.pendingOutlineG = false;
  }

  /** The key after Ctrl-w / W. Ctrl may still be held (Ctrl-w Ctrl-v), as
   *  Vim allows, so only the key itself matters. */
  private windowCommand(key: string): void {
    const k = key.length === 1 ? key.toLowerCase() : key;
    switch (k) {
      case "v":
        this.openSplit("vertical");
        return;
      case "s":
        this.openSplit("horizontal");
        return;
      case "w":
      case "p":
        if (this.ref.isOpen) this.focusPane(this.refFocused ? "main" : "ref");
        return;
      case "h":
      case "j":
      case "k":
      case "l": {
        const toward = this.paneToward(k);
        if (toward) this.focusPane(toward);
        return;
      }
      case "c":
      case "q":
        if (!this.ref.isOpen) this.flashStatus("only one window");
        else if (this.refFocused) this.closeRef();
        else this.promoteRef();
        return;
      case "o":
        if (!this.ref.isOpen) return;
        if (this.refFocused) this.promoteRef();
        else this.closeRef();
        return;
      case "x":
        this.exchangePanes();
        return;
      case "Escape":
        return;
      default:
        this.flashStatus(`no window command ${key}`);
    }
  }

  /**
   * Run an Ex command from the `:` line. Only the window commands and a
   * page jump — enough for `:q` muscle memory, not an Ex implementation.
   * Abbreviations follow Vim's (`:clo`, `:on`, `:vs`, `:sp`).
   */
  private runCommand(cmd: string): void {
    // `:12` — go to page 12 in the focused pane, like 12G.
    if (/^\d+$/.test(cmd)) {
      this.pane.goToPage(parseInt(cmd, 10));
      return;
    }
    // Vim ignores a trailing `!` on these; nothing here has unsaved state.
    const name = cmd.replace(/!$/, "");
    const winCmd = ((): string | null => {
      if (/^(q(u(it?)?)?|wq|x(it?)?|exi(t)?|clo(se?)?)$/.test(name)) return "q";
      if (/^on(ly?)?$/.test(name)) return "o";
      if (/^vs(p(l(it?)?)?)?$/.test(name)) return "v";
      if (/^sp(l(it?)?)?$/.test(name)) return "s";
      return null;
    })();
    if (winCmd) {
      this.windowCommand(winCmd);
      return;
    }
    this.flashStatus(`Not an editor command: ${cmd}`);
  }

  /** The pane in direction h/j/k/l, if there is one. The reference pane sits
   *  right of (vsplit) or below (split) the main one. */
  private paneToward(k: string): "main" | "ref" | undefined {
    const dir = this.ref.splitDirection;
    if (dir === "vertical") return { h: "main", l: "ref" }[k] as "main" | "ref" | undefined;
    if (dir === "horizontal") return { k: "main", j: "ref" }[k] as "main" | "ref" | undefined;
    return undefined;
  }

  private matchesScrollAlias(e: KeyboardEvent): boolean {
    const s = this.viewer.settings;
    return [s.halfPageDownKey, s.halfPageUpKey, s.fullPageDownKey, s.fullPageUpKey]
      .some((alias) => matchesAlias(e, alias));
  }

  private openSplit(direction: SplitDirection): void {
    if (!this.viewer.pdfDocument) return;
    // A new split starts with no history; one re-laid-out keeps it.
    if (!this.ref.isOpen) this.jumpLists.delete(this.ref);
    // Lays the split out synchronously, so the pane can take focus now.
    void this.ref.open(direction);
    this.focusPane("ref");
  }

  private focusPane(which: "main" | "ref"): void {
    const toRef = which === "ref" && this.ref.isOpen;
    // The caret's span indices belong to the pane it was placed in; carried
    // across, j/k would steer a caret the user can no longer see.
    // Compared with the pane in effect, not refFocused: a split closed under
    // us (Viewer.load on a dropped file) leaves refFocused stale.
    if (toRef !== (this.pane === this.ref) && this.caretMode.isActive) this.caretMode.exit();
    // Likewise the outline: with its focus kept, j/k/Enter would steer the
    // outline rather than the pane that now shows focus.
    if (toRef) clearOutlineFocus();
    this.scroller.stop();
    this.refFocused = toRef;
    this.viewer.container.classList.toggle("pane-focused", !toRef);
    this.ref.container.classList.toggle("pane-focused", toRef);
    this.viewer.statusPane = this.pane;
    this.viewer.updateStatus();
    this.pane.container.focus();
  }

  private closeRef(): void {
    this.ref.close();
    this.focusPane("main");
  }

  /**
   * Close the main pane's view and keep the reference pane's — what Vim's
   * :close does on the other window. The main pane stays (it owns caret
   * mode and search), so it takes over the reference pane's position and
   * zoom instead.
   */
  private promoteRef(): void {
    // A caret left on its old span would scroll the main pane back to it on
    // the next page render.
    if (this.caretMode.isActive) this.caretMode.exit();
    const anchor = this.ref.captureMarkAnchor();
    const scale = this.ref.shownScaleValue();
    // The main pane is the one about to move, whichever pane has focus.
    this.jumpsFor(this.viewer).record(this.snapshot(this.viewer));
    this.closeRef();
    this.viewer.pdfViewer.currentScaleValue = scale;
    if (anchor) this.viewer.restoreMarkAnchor(anchor);
  }

  /** Ctrl-w x: swap the two panes' views, e.g. to bring a figure into the
   *  main pane where it can be selected and yanked. */
  private exchangePanes(): void {
    if (!this.ref.isOpen) return;
    if (this.caretMode.isActive) this.caretMode.exit(); // as in promoteRef
    const mainAnchor = this.viewer.captureMarkAnchor();
    const refAnchor = this.ref.captureMarkAnchor();
    const mainScale = this.viewer.shownScaleValue();
    const refScale = this.ref.shownScaleValue();
    if (!mainAnchor || !refAnchor) return;
    // Both panes move, so each gets a way back.
    this.jumpsFor(this.viewer).record(this.snapshot(this.viewer));
    this.jumpsFor(this.ref).record(this.snapshot(this.ref));
    this.viewer.pdfViewer.currentScaleValue = refScale;
    this.ref.pdfViewer.currentScaleValue = mainScale;
    this.viewer.restoreMarkAnchor(refAnchor);
    this.ref.restoreMarkAnchor(mainAnchor);
  }

  private flashStatus(text: string): void {
    this.viewer.setStatusCenter(text);
    setTimeout(() => this.viewer.clearStatusCenter(), 1200);
  }

  /**
   * Dispatch a scroll key:
   *  - first press (no repeat): one smooth step
   *  - held (repeat=true): hand off to rAF continuous scroller
   */
  private handleScroll(
    e: KeyboardEvent,
    _key: ScrollKey,
    axis: "x" | "y",
    direction: 1 | -1,
    step: number,
  ): void {
    if (e.repeat) {
      this.scroller.start(axis, direction);
      return;
    }
    if (axis === "y") this.pane.scrollBy(0, direction * step);
    else this.pane.scrollBy(direction * step, 0);
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "j" || e.key === "k" || e.key === "h" || e.key === "l") {
      this.scroller.stop();
    }
  };

  private enterHint(newTab: boolean): void {
    const ok = this.hints.activate({
      // Both panes of a split: each renders its own annotation layer, and a
      // link followed there navigates that pane through its own linkService.
      panes: this.ref.isOpen ? [this.viewer, this.ref] : [this.viewer],
      newTab,
      onExit: () => {
        this.mode = "normal";
      },
      onBeforeFollow: (link, pane) => {
        const toRef = pane === this.ref;
        // Keys after the jump should drive the pane that just moved.
        if (toRef !== this.refFocused) this.focusPane(toRef ? "ref" : "main");
        // Into the pane that moves, which focusPane just made this.pane.
        if (this.isInternalLink(link)) {
          this.jumps.record(this.snapshot());
        }
      },
    });
    if (!ok) {
      this.viewer.setStatusCenter("no links in view");
      setTimeout(() => this.viewer.clearStatusCenter(), 1200);
      return;
    }
    this.mode = "hint";
  }

  private jumpsFor(pane: Pane): JumpList {
    let list = this.jumpLists.get(pane);
    if (!list) {
      list = new JumpList();
      this.jumpLists.set(pane, list);
    }
    return list;
  }

  /** The focused pane's jump list. */
  private get jumps(): JumpList {
    return this.jumpsFor(this.pane);
  }

  private snapshot(pane: Pane = this.pane): JumpPos {
    return {
      page: pane.currentPage,
      scrollTop: pane.container.scrollTop,
      scrollLeft: pane.container.scrollLeft,
    };
  }

  private restore(pos: JumpPos): void {
    const pane = this.pane;
    // Ensure PDF.js has laid out the target page before we scroll.
    pane.goToPage(pos.page);
    requestAnimationFrame(() => {
      pane.container.scrollTo({
        top: pos.scrollTop,
        left: pos.scrollLeft,
        behavior: "auto",
      });
    });
  }

  private jumpBack(): void {
    const prev = this.jumps.popBack(this.snapshot());
    if (!prev) {
      this.viewer.setStatusCenter("no earlier jump");
      setTimeout(() => this.viewer.clearStatusCenter(), 1200);
      return;
    }
    this.restore(prev);
  }

  private jumpForward(): void {
    const next = this.jumps.popForward(this.snapshot());
    if (!next) {
      this.viewer.setStatusCenter("no later jump");
      setTimeout(() => this.viewer.clearStatusCenter(), 1200);
      return;
    }
    this.restore(next);
  }

  private sendTabCommand(
    action:
      | "next"
      | "prev"
      | "first"
      | "last"
      | "new"
      | "close"
      | "back"
      | "forward",
  ): void {
    void chrome.runtime.sendMessage({ type: "vimdf.tab", action });
  }

  private isInternalLink(link: HTMLAnchorElement): boolean {
    if (link.target === "_blank") return false;
    const raw = link.getAttribute("href") ?? "";
    if (raw.startsWith("#")) return true;
    try {
      const u = new URL(link.href, location.href);
      return u.origin === location.origin && u.pathname === location.pathname;
    } catch {
      return false;
    }
  }

  private openFinder(): void {
    this.mode = "finder";
    void this.finder.show();
  }

  private enterSearch(): void {
    this.mode = "search";
    const bar = document.getElementById("searchbar");
    const input = document.getElementById("searchInput") as HTMLInputElement;
    bar?.removeAttribute("hidden");
    input.value = "";
    input.focus();
    this.viewer.findStatusEnabled = true;
    this.search.begin();
  }

  private exitSearch(opts: { clear: boolean }): void {
    this.mode = "normal";
    const bar = document.getElementById("searchbar");
    bar?.setAttribute("hidden", "");
    if (opts.clear) {
      this.viewer.findStatusEnabled = false;
      this.search.clear();
      this.viewer.clearStatusCenter();
    }
    this.viewer.container.focus();
  }

  private isHelpOpen(): boolean {
    const help = document.getElementById("help");
    return !!help && !help.hasAttribute("hidden");
  }

  private toggleHelp(): void {
    if (this.isHelpOpen()) this.closeHelp();
    else this.openHelp();
  }

  private openHelp(): void {
    document.getElementById("help")?.removeAttribute("hidden");
  }

  private closeHelp(): void {
    this.closeHelpSearch();
    document.getElementById("help")?.setAttribute("hidden", "");
  }

  // --- Help overlay key handling ---

  // `gg` prefix (scoped to help so it doesn't collide with the main `gg`).
  private helpPendingG = false;

  /**
   * Handle a keystroke while the help overlay is visible. Returns true if
   * the event was consumed; the outer handler always ignores the rest of
   * its pipeline in that case. When the help-search input is focused we
   * return false for non-navigation keys so the input processes them
   * naturally.
   */
  private handleHelpKey(e: KeyboardEvent): boolean {
    const key = e.key;
    const searchInput = document.getElementById(
      "helpSearchInput",
    ) as HTMLInputElement | null;
    const searchActive =
      !!searchInput &&
      !document.getElementById("helpSearch")!.hasAttribute("hidden");
    const focused = document.activeElement === searchInput;

    // Input-focused flow: Esc closes the filter (back to scroll mode);
    // Enter dismisses focus. Let every other key through to the <input>.
    if (focused && searchActive) {
      if (key === "Escape") {
        e.preventDefault();
        this.closeHelpSearch();
        return true;
      }
      if (key === "Enter") {
        e.preventDefault();
        searchInput!.blur();
        return true;
      }
      return true; // consume so outer handler doesn't act, input handles it
    }

    // Scroll / navigation mode.
    const helpEl = document.querySelector<HTMLElement>("#help .help-inner");
    if (!helpEl) {
      // Fallback: just honour ?/Esc to close.
      if (key === "?" || key === "Escape") {
        e.preventDefault();
        this.closeHelp();
      }
      return true;
    }

    if (key === "Escape") {
      e.preventDefault();
      if (searchActive) this.closeHelpSearch();
      else this.closeHelp();
      return true;
    }
    if (key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.closeHelp();
      return true;
    }

    // `gg` two-key sequence.
    if (this.helpPendingG) {
      this.helpPendingG = false;
      if (key === "g") {
        e.preventDefault();
        helpEl.scrollTop = 0;
        return true;
      }
    }

    const step = this.viewer.settings.scrollStep;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      const lk = key.toLowerCase();
      if (lk === "d") {
        e.preventDefault();
        helpEl.scrollBy({ top: helpEl.clientHeight * 0.5, behavior: "auto" });
        return true;
      }
      if (lk === "u") {
        e.preventDefault();
        helpEl.scrollBy({ top: -helpEl.clientHeight * 0.5, behavior: "auto" });
        return true;
      }
      if (lk === "f") {
        e.preventDefault();
        helpEl.scrollBy({ top: helpEl.clientHeight * 0.95, behavior: "auto" });
        return true;
      }
      if (lk === "b") {
        e.preventDefault();
        helpEl.scrollBy({ top: -helpEl.clientHeight * 0.95, behavior: "auto" });
        return true;
      }
    }

    switch (key) {
      case "j":
        e.preventDefault();
        helpEl.scrollBy({ top: step, behavior: "auto" });
        return true;
      case "k":
        e.preventDefault();
        helpEl.scrollBy({ top: -step, behavior: "auto" });
        return true;
      case "g":
        e.preventDefault();
        this.helpPendingG = true;
        return true;
      case "G":
        e.preventDefault();
        helpEl.scrollTop = helpEl.scrollHeight;
        return true;
      case "/":
        e.preventDefault();
        this.openHelpSearch();
        return true;
    }

    // Swallow other plain keys so they don't reach the PDF viewer behind
    // the overlay. Modifier combos (Cmd+C copy, Ctrl+F native find, etc.)
    // fall through to the browser.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
    }
    return true;
  }

  private openHelpSearch(): void {
    const bar = document.getElementById("helpSearch");
    const input = document.getElementById(
      "helpSearchInput",
    ) as HTMLInputElement | null;
    if (!bar || !input) return;
    bar.removeAttribute("hidden");
    input.focus();
    input.select();
    // Wire the input listener lazily so we don't need to care about it
    // during initial construction.
    if (!input.dataset.vimdfBound) {
      input.addEventListener("input", () => this.applyHelpFilter(input.value));
      input.dataset.vimdfBound = "1";
    }
    this.applyHelpFilter(input.value);
  }

  private closeHelpSearch(): void {
    const bar = document.getElementById("helpSearch");
    const input = document.getElementById(
      "helpSearchInput",
    ) as HTMLInputElement | null;
    if (input) input.value = "";
    bar?.setAttribute("hidden", "");
    this.applyHelpFilter("");
  }

  /**
   * Hide every binding row whose text doesn't contain the query. A section
   * header (first cell spans both columns) follows the visibility of the
   * rows beneath it so a matched binding still shows its group.
   */
  private applyHelpFilter(raw: string): void {
    const q = raw.trim().toLowerCase();
    const rows = Array.from(
      document.querySelectorAll<HTMLTableRowElement>("#help table tr"),
    );
    if (!q) {
      for (const r of rows) r.classList.remove("help-filter-hidden");
      this.setHelpSearchStatus("");
      return;
    }
    // First pass: data rows.
    type Row = { el: HTMLTableRowElement; isHeader: boolean; matches: boolean };
    const info: Row[] = rows.map((el) => {
      const isHeader = !!el.querySelector("th");
      const text = (el.textContent ?? "").toLowerCase();
      return { el, isHeader, matches: !isHeader && text.includes(q) };
    });
    // Second pass: header visible iff any data row between this header
    // and the next header matches.
    let matchedCount = 0;
    for (let i = 0; i < info.length; i++) {
      const row = info[i];
      if (!row.isHeader) {
        if (row.matches) matchedCount++;
        row.el.classList.toggle("help-filter-hidden", !row.matches);
        continue;
      }
      let anyMatch = false;
      for (let j = i + 1; j < info.length && !info[j].isHeader; j++) {
        if (info[j].matches) {
          anyMatch = true;
          break;
        }
      }
      row.el.classList.toggle("help-filter-hidden", !anyMatch);
    }
    this.setHelpSearchStatus(
      `${matchedCount} match${matchedCount === 1 ? "" : "es"}`,
    );
  }

  private setHelpSearchStatus(text: string): void {
    const el = document.getElementById("helpSearchStatus");
    if (el) el.textContent = text;
  }
}

/** Keys for features only the main pane has: caret mode, link hints,
 *  search, the outline, and the jump list. */
function isMainPaneKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.altKey) return false;
  if (e.ctrlKey) {
    if (e.shiftKey) return false;
    const k = e.key.toLowerCase();
    // Ctrl-h only does something when there is an outline to focus.
    // Ctrl-h only does something when there is an outline to focus.
    return k === "h" && isSidebarOpen() && hasOutlineItems();
  }
  return ["/", "n", "N", "o"].includes(e.key);
}

function matchesAlias(e: KeyboardEvent, alias: string): boolean {
  if (!alias) return false;
  const parts = alias.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  if (e.ctrlKey !== mods.includes("ctrl")) return false;
  if (e.altKey !== mods.includes("alt")) return false;
  if (e.metaKey !== mods.includes("meta")) return false;
  return e.key === key;
}
