import type { Viewer } from "./viewer";
import type { MarksStore } from "./marks";
import type { SearchController } from "./search";
import type { Settings } from "../common/settings";
import {
  activateFocusedOutline,
  clearOutlineFocus,
  focusCurrentSection,
  focusFirstOutlineItem,
  hasOutlineItems,
  isOutlineFocusActive,
  isSidebarOpen,
  moveOutlineFocus,
  toggleSidebar,
} from "./outline";
import { ContinuousScroll } from "./continuous-scroll";
import { HintController } from "./hints";
import { JumpList, type JumpPos } from "./jump-list";
import { CaretMode } from "./caret-mode";
import { Finder } from "./finder";

type Mode = "normal" | "search" | "hint" | "finder";
type ScrollKey = "j" | "k" | "h" | "l";

export class VimController {
  private mode: Mode = "normal";

  // Multi-key buffers
  private pendingCount = "";
  private pendingG = false;
  private pendingMark: "set" | "jump" | null = null;

  private scroller: ContinuousScroll;
  private hints: HintController;
  private jumps = new JumpList();
  private caretMode: CaretMode;
  private finder: Finder;

  constructor(
    private viewer: Viewer,
    private marks: MarksStore,
    private search: SearchController,
  ) {
    this.scroller = new ContinuousScroll(viewer.container);
    this.hints = new HintController(viewer);
    this.caretMode = new CaretMode(viewer);
    this.finder = new Finder(viewer, marks, {
      recordJump: () => this.jumps.record(this.snapshot()),
      getHighlights: () => viewer.highlights,
      onClose: () => {
        this.mode = "normal";
        this.viewer.container.focus();
      },
    });
    viewer.eventBus.on("pagerendered", () => this.caretMode.render());
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

    // Trackpad pinch + Ctrl/Cmd+wheel: route through PDF.js zoom rather than
    // browser page-zoom, which has its own floor and drifts out of sync with
    // the PDF.js scale.
    this.viewer.container.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.01);
        this.viewer.zoomBy(factor);
      },
      { passive: false },
    );

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
      return;
    }

    // Download / Print — intercept browser defaults (Save Page As / Print
    // dialog targeting the viewer UI) and drive PDF-aware flows instead.
    // Matches normal PDF viewers: Ctrl/Cmd+S saves the PDF bytes, Ctrl/Cmd+P
    // prints the rendered pages.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const lk = key.toLowerCase();
      if (lk === "s") {
        e.preventDefault();
        void this.viewer.download();
        return;
      }
      if (lk === "p") {
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

    // Outline navigation takes priority over caret mode so j/k/Enter can steer
    // the sidebar even while caret insert/visual is active.
    if (isOutlineFocusActive()) {
      if (key === "j") {
        e.preventDefault();
        moveOutlineFocus(1);
        return;
      }
      if (key === "k") {
        e.preventDefault();
        moveOutlineFocus(-1);
        return;
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
      if (
        key === "Escape" ||
        (e.ctrlKey && !e.shiftKey && !e.altKey && key.toLowerCase() === "h")
      ) {
        e.preventDefault();
        clearOutlineFocus();
        return;
      }
      clearOutlineFocus();
      // fall through to caret / normal handling
    }

    if (this.caretMode.isActive) {
      // Let the jump-list navigate even inside insert mode — useful after
      // following a citation link. Visual modes are left alone so the
      // anchor isn't lost.
      if (this.caretMode.isInsert) {
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
        // Plain `o` toggles the sidebar. Auto-focuses the current section
        // so j/k can drive the outline without leaving caret insert.
        if (key === "o" && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          toggleSidebar();
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
        this.marks.set(key, {
          page: this.viewer.currentPage,
          scrollTop: this.viewer.container.scrollTop,
          scrollLeft: this.viewer.container.scrollLeft,
        });
        this.viewer.setStatusCenter(`mark ${key} set`);
        setTimeout(() => this.viewer.clearStatusCenter(), 1200);
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
          this.viewer.goToPage(m.page);
          // After page change, PDF.js snaps to page top; apply offset shortly.
          requestAnimationFrame(() => {
            this.viewer.container.scrollTo({
              top: m.scrollTop,
              left: m.scrollLeft,
              behavior: "auto",
            });
          });
        } else {
          this.viewer.setStatusCenter(`mark ${key} not set`);
          setTimeout(() => this.viewer.clearStatusCenter(), 1200);
        }
      }
      return;
    }

    // gg sequence
    if (this.pendingG) {
      this.pendingG = false;
      if (key === "g") {
        e.preventDefault();
        this.viewer.goToPage(1);
        return;
      }
      // fall through — g was not followed by g
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
          this.viewer.scrollHalfPage(1);
          return;
        case "u":
          e.preventDefault();
          this.viewer.scrollHalfPage(-1);
          return;
        case "f":
          e.preventDefault();
          this.viewer.scrollFullViewport(1);
          return;
        case "b":
          e.preventDefault();
          this.viewer.scrollFullViewport(-1);
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
      this.viewer.scrollHalfPage(1);
      return;
    }
    if (matchesAlias(e, s.halfPageUpKey)) {
      e.preventDefault();
      this.viewer.scrollHalfPage(-1);
      return;
    }
    if (matchesAlias(e, s.fullPageDownKey)) {
      e.preventDefault();
      this.viewer.scrollFullViewport(1);
      return;
    }
    if (matchesAlias(e, s.fullPageUpKey)) {
      e.preventDefault();
      this.viewer.scrollFullViewport(-1);
      return;
    }

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
        this.viewer.goToPage(count > 0 ? count : this.viewer.numPages);
        return;

      case "+":
      case "=":
        e.preventDefault();
        this.viewer.zoomIn();
        return;
      case "-":
        e.preventDefault();
        this.viewer.zoomOut();
        return;
      case "0":
        e.preventDefault();
        this.viewer.fitWidth();
        return;

      case "T":
        e.preventDefault();
        this.openFinder();
        return;

      case "o":
        e.preventDefault();
        toggleSidebar();
        if (isSidebarOpen() && hasOutlineItems()) {
          if (!focusCurrentSection(this.viewer.currentPage)) {
            focusFirstOutlineItem();
          }
        }
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
    if (axis === "y") this.viewer.scrollBy(0, direction * step);
    else this.viewer.scrollBy(direction * step, 0);
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "j" || e.key === "k" || e.key === "h" || e.key === "l") {
      this.scroller.stop();
    }
  };

  private enterHint(newTab: boolean): void {
    const ok = this.hints.activate({
      newTab,
      onExit: () => {
        this.mode = "normal";
      },
      onBeforeFollow: (link) => {
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

  private snapshot(): JumpPos {
    return {
      page: this.viewer.currentPage,
      scrollTop: this.viewer.container.scrollTop,
      scrollLeft: this.viewer.container.scrollLeft,
    };
  }

  private restore(pos: JumpPos): void {
    // Ensure PDF.js has laid out the target page before we scroll.
    this.viewer.goToPage(pos.page);
    requestAnimationFrame(() => {
      this.viewer.container.scrollTo({
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
