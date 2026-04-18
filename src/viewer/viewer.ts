import "pdfjs-dist/web/pdf_viewer.css";
import "./viewer.css";

import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";

import { VimController } from "./vim-controller";
import { MarksStore } from "./marks";
import { SearchController } from "./search";
import { buildOutline } from "./outline";
import {
  HighlightStore,
  renderHighlightsForPage,
  type Highlight,
} from "./highlights";
import {
  loadSettings,
  onSettingsChanged,
  resolveThemeClass,
  type Settings,
} from "../common/settings";
import { checkAndShowConflictWarning } from "./conflict-notification";
import { downloadPdf, printPdf, suggestedFilename } from "./print";
import { showSaveDialog } from "./save-dialog";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 10;

export class Viewer {
  readonly container: HTMLDivElement;
  readonly viewerEl: HTMLDivElement;
  readonly pdfViewer: PDFViewer;
  readonly linkService: PDFLinkService;
  readonly findController: PDFFindController;
  readonly eventBus: EventBus;

  pdfDocument: PDFDocumentProxy | null = null;
  pdfUrl: string = "";
  settings: Settings;

  private highlightStore: HighlightStore | null = null;
  private userHighlights: Highlight[] = [];

  get highlights(): ReadonlyArray<Highlight> {
    return this.userHighlights;
  }

  /**
   * Last destination passed to PDF.js's scrollPageIntoView. Captured so that
   * post-link-jump features (e.g. caret-mode's initial placement) can land
   * near the citation anchor rather than the viewport midpoint.
   */
  lastJumpDest: { pageIdx: number; xPdf: number | null; yPdf: number | null } | null = null;

  private statusLeft = document.getElementById("statusLeft")!;
  private statusCenter = document.getElementById("statusCenter")!;
  private statusRight = document.getElementById("statusRight")!;

  private savePageScheduled = false;

  constructor(settings: Settings) {
    this.settings = settings;
    this.container = document.getElementById(
      "viewerContainer",
    ) as HTMLDivElement;
    this.viewerEl = document.getElementById("viewer") as HTMLDivElement;

    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      // Don't let dest arrays (outline, named dests, intra-doc links) override
      // the user's current zoom — XYZ/Fit dests with explicit scales otherwise
      // snap the view to page-width on every jump.
      ignoreDestinationZoom: true,
    });
    this.findController = new PDFFindController({
      eventBus: this.eventBus,
      linkService: this.linkService,
    });

    this.pdfViewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      textLayerMode: 1,
      annotationEditorMode: -1,
    });
    this.linkService.setViewer(this.pdfViewer);

    // Capture link/outline/find destinations so caret-mode can start the
    // caret at the anchor rather than the viewport midpoint.
    //
    // Also: pdf.js's internal scrollIntoView silently no-ops under our
    // container layout (nested position:relative #viewer whose
    // clientHeight === scrollHeight makes the util's scroll-target walk exit
    // on the wrong ancestor). We fall back to aligning the destination
    // page's top with the container's top via getBoundingClientRect, which
    // is layout-agnostic.
    const origSPIV = this.pdfViewer.scrollPageIntoView.bind(this.pdfViewer);
    this.pdfViewer.scrollPageIntoView = (params: Parameters<typeof origSPIV>[0]) => {
      if (params?.destArray) {
        this.recordJumpDest(params.pageNumber, params.destArray as unknown[]);
      }
      const ret = origSPIV(params);
      const pageIdx = (params?.pageNumber ?? 0) - 1;
      const pv = (this.pdfViewer as unknown as {
        _pages?: Array<{ div?: HTMLElement }>;
      })._pages?.[pageIdx];
      const div = pv?.div;
      if (div) {
        const r = div.getBoundingClientRect();
        const cr = this.container.getBoundingClientRect();
        if (Math.abs(r.top - cr.top) > 4) {
          this.container.scrollTop += r.top - cr.top;
        }
      }
      return ret;
    };

    this.eventBus.on("pagesinit", () => {
      this.pdfViewer.currentScaleValue = "page-width";
      this.updateStatus();
    });

    this.eventBus.on("pagechanging", () => {
      this.updateStatus();
      this.schedulePageSave();
    });
    this.eventBus.on("scalechanging", () => this.updateStatus());

    this.eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      this.renderHighlightsForPage(e.pageNumber - 1);
    });

    this.eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => {
      // PDFFindController flushes count updates on a promise chain after
      // `findbarclose`, so events arrive *after* we've cleared the status
      // bar on Esc. Gate behind `findStatusEnabled` so post-close emits
      // don't stomp the cleared bar.
      if (!this.findStatusEnabled) return;
      const { current, total } = e.matchesCount;
      if (total > 0) {
        this.setStatusCenter(`${current} / ${total}`);
      }
    });
    this.eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount?: { current: number; total: number } }) => {
      if (!this.findStatusEnabled) return;
      // state 0=found, 1=notfound, 2=wrapped, 3=pending
      if (e.state === 1) this.setStatusCenter("no match");
      else if (e.matchesCount && e.matchesCount.total > 0)
        this.setStatusCenter(`${e.matchesCount.current} / ${e.matchesCount.total}`);
    });
  }

  async load(url: string): Promise<void> {
    this.pdfUrl = url;
    const loadingTask = getDocument({
      url,
      cMapUrl: chrome.runtime.getURL("cmaps/"),
      cMapPacked: true,
      withCredentials: false,
    });
    this.pdfDocument = await loadingTask.promise;
    this.pdfViewer.setDocument(this.pdfDocument);
    this.linkService.setDocument(this.pdfDocument, null);

    this.highlightStore = new HighlightStore(url);
    this.userHighlights = await this.highlightStore.load();

    await this.applyDocumentTitle();
    await buildOutline(this.pdfDocument, this.linkService);
    await this.restoreState();
    this.updateStatus();
  }

  private async applyDocumentTitle(): Promise<void> {
    if (!this.pdfDocument) return;
    let title = "";
    try {
      const { info, metadata } = (await this.pdfDocument.getMetadata()) as {
        info?: { Title?: string };
        metadata?: { get(key: string): string | null } | null;
      };
      const xmpTitle = metadata?.get("dc:title");
      const infoTitle = info?.Title;
      title = (xmpTitle ?? infoTitle ?? "").trim();
    } catch {
      // Metadata retrieval can fail on malformed PDFs; fall through to URL.
    }
    if (!title && this.pdfUrl) {
      try {
        const pathname = new URL(this.pdfUrl).pathname;
        title = decodeURIComponent(pathname.split("/").pop() ?? "");
      } catch {
        // Non-URL input, leave blank.
      }
    }
    document.title = title ? `${title} — VimDF` : "VimDF";
  }

  private recordJumpDest(pageNumber: number, destArray: unknown[]): void {
    // destArray: [ref, { name }, ...coords]. For XYZ: (left, top, zoom);
    // FitH/FitBH: (top); Fit/FitB: no coords.
    const name = (destArray[1] as { name?: string } | undefined)?.name;
    let xPdf: number | null = null;
    let yPdf: number | null = null;
    if (name === "XYZ" || name === "FitR") {
      xPdf = typeof destArray[2] === "number" ? (destArray[2] as number) : null;
      yPdf = typeof destArray[3] === "number" ? (destArray[3] as number) : null;
    } else if (name === "FitH" || name === "FitBH") {
      yPdf = typeof destArray[2] === "number" ? (destArray[2] as number) : null;
    }
    this.lastJumpDest = { pageIdx: pageNumber - 1, xPdf, yPdf };
  }

  /**
   * Convert the last captured jump destination to viewport (client) pixel
   * coordinates on the target page element. Returns null if we lack the
   * coords or the page isn't laid out yet.
   */
  resolveJumpDestClient(): { pageIdx: number; clientX: number | null; clientY: number | null } | null {
    const dest = this.lastJumpDest;
    if (!dest) return null;
    const pageView = this.pdfViewer.getPageView(dest.pageIdx) as
      | { viewport?: { convertToViewportPoint: (x: number, y: number) => [number, number] } }
      | null;
    const pageEl = document.querySelector(
      `.page[data-page-number="${dest.pageIdx + 1}"]`,
    ) as HTMLElement | null;
    if (!pageView?.viewport || !pageEl) return null;
    const pageRect = pageEl.getBoundingClientRect();
    let clientX: number | null = null;
    let clientY: number | null = null;
    if (dest.xPdf !== null && dest.yPdf !== null) {
      const [vx, vy] = pageView.viewport.convertToViewportPoint(dest.xPdf, dest.yPdf);
      clientX = pageRect.left + vx;
      clientY = pageRect.top + vy;
    } else if (dest.yPdf !== null) {
      const [, vy] = pageView.viewport.convertToViewportPoint(0, dest.yPdf);
      clientY = pageRect.top + vy;
    }
    return { pageIdx: dest.pageIdx, clientX, clientY };
  }

  clearJumpDest(): void {
    this.lastJumpDest = null;
  }

  // --- Navigation ---

  get numPages(): number {
    return this.pdfDocument?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.pdfViewer.currentPageNumber;
  }

  goToPage(page: number): void {
    const clamped = Math.max(1, Math.min(this.numPages, page));
    this.pdfViewer.currentPageNumber = clamped;
  }

  scrollBy(dx: number, dy: number, behavior: ScrollBehavior = "smooth"): void {
    this.container.scrollBy({ left: dx, top: dy, behavior });
  }

  scrollPages(delta: number): void {
    const next = this.currentPage + delta;
    this.goToPage(next);
  }

  // Ctrl-d/u/f/b jump instantly, matching Vim's half/full-page scroll.
  scrollHalfPage(direction: 1 | -1): void {
    this.scrollBy(0, direction * this.container.clientHeight * 0.5, "auto");
  }

  scrollFullViewport(direction: 1 | -1): void {
    this.scrollBy(0, direction * this.container.clientHeight * 0.95, "auto");
  }

  // --- Zoom ---

  zoomBy(factor: number): void {
    // PDF.js's `currentScaleValue` setter doesn't preserve the viewer's
    // visible region on its own — the viewport drifts because the content
    // above grows / shrinks but scrollTop stays fixed. Keep the viewport
    // centre anchored on the same content by scaling scroll offsets in
    // proportion to the new scroll dimensions.
    const oldW = this.container.scrollWidth;
    const oldH = this.container.scrollHeight;
    const cx = this.container.scrollLeft + this.container.clientWidth / 2;
    const cy = this.container.scrollTop + this.container.clientHeight / 2;

    const next = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, this.pdfViewer.currentScale * factor),
    );
    this.pdfViewer.currentScaleValue = String(next);

    const newW = this.container.scrollWidth;
    const newH = this.container.scrollHeight;
    if (oldW > 0 && oldH > 0) {
      this.container.scrollLeft =
        cx * (newW / oldW) - this.container.clientWidth / 2;
      this.container.scrollTop =
        cy * (newH / oldH) - this.container.clientHeight / 2;
    }
  }

  zoomIn(): void {
    this.zoomBy(this.settings.zoomStep);
  }

  zoomOut(): void {
    this.zoomBy(1 / this.settings.zoomStep);
  }

  fitWidth(): void {
    this.pdfViewer.currentScaleValue = "page-width";
  }

  // --- Download / Print ---

  download(): void {
    if (!this.pdfDocument) return;
    const doc = this.pdfDocument;
    void (async () => {
      const initialSubdir = await loadLastDownloadSubdir();
      showSaveDialog({
        defaultName: suggestedFilename(this.pdfUrl),
        initialSubdir,
        onCancel: () => {
          this.container.focus();
        },
        onConfirm: (filename, subdir) => {
          this.container.focus();
          void (async () => {
            try {
              await downloadPdf(doc, { filename });
              await saveLastDownloadSubdir(subdir);
              this.setStatusCenter(`saved ${filename}`);
              setTimeout(() => this.clearStatusCenter(), 1500);
            } catch (err) {
              console.error("download failed:", err);
              this.setStatusCenter("download failed");
              setTimeout(() => this.clearStatusCenter(), 1800);
            }
          })();
        },
        onSaveAs: (filename) => {
          this.container.focus();
          void (async () => {
            try {
              await downloadPdf(doc, { filename, saveAs: true });
              this.setStatusCenter("saved");
              setTimeout(() => this.clearStatusCenter(), 1500);
            } catch (err) {
              // User cancellation surfaces as an error here; ignore silently.
              if (!isUserCancellation(err)) {
                console.error("save-as failed:", err);
                this.setStatusCenter("save failed");
                setTimeout(() => this.clearStatusCenter(), 1800);
              }
            }
          })();
        },
      });
    })();
  }

  async print(): Promise<void> {
    if (!this.pdfDocument) return;
    this.setStatusCenter("preparing print…");
    try {
      await printPdf(this.pdfDocument);
    } catch (err) {
      console.error("print failed:", err);
    } finally {
      this.clearStatusCenter();
    }
  }

  // --- Highlights ---

  async addHighlight(hl: Highlight): Promise<void> {
    if (!this.highlightStore) return;
    this.userHighlights.push(hl);
    await this.highlightStore.save(this.userHighlights);
    const pages = new Set(hl.rects.map((r) => r.pageIndex));
    for (const idx of pages) this.renderHighlightsForPage(idx);
  }

  async removeHighlight(id: string): Promise<void> {
    if (!this.highlightStore) return;
    const before = this.userHighlights.find((h) => h.id === id);
    if (!before) return;
    this.userHighlights = this.userHighlights.filter((h) => h.id !== id);
    await this.highlightStore.save(this.userHighlights);
    const pages = new Set(before.rects.map((r) => r.pageIndex));
    for (const idx of pages) this.renderHighlightsForPage(idx);
  }

  private renderHighlightsForPage(pageIdx: number): void {
    const pageEl = this.viewerEl.querySelector(
      `.page[data-page-number="${pageIdx + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return;
    renderHighlightsForPage(pageEl, pageIdx, this.userHighlights, (id) => {
      void this.removeHighlight(id);
    });
  }

  // --- Persistence ---

  private storageKey(): string {
    return `vimdf:state:${this.pdfUrl}`;
  }

  private async saveState(): Promise<void> {
    if (!this.pdfUrl) return;
    const existing = await chrome.storage.local.get(this.storageKey());
    const prev = (existing[this.storageKey()] ?? {}) as {
      page?: number;
    };
    const next: typeof prev = { ...prev };
    if (this.settings.rememberLastPage) next.page = this.currentPage;
    await chrome.storage.local.set({ [this.storageKey()]: next });
  }

  /**
   * Debounce page saves: pagechanging fires on every visible-page update
   * while scrolling. We only need the latest value.
   */
  private schedulePageSave(): void {
    if (!this.settings.rememberLastPage) return;
    if (this.savePageScheduled) return;
    this.savePageScheduled = true;
    setTimeout(() => {
      this.savePageScheduled = false;
      void this.saveState();
    }, 400);
  }

  private async restoreState(): Promise<void> {
    if (!this.pdfUrl) return;
    const key = this.storageKey();
    const result = await chrome.storage.local.get(key);
    const state = result[key] as { page?: number } | undefined;
    if (!state) return;
    if (
      this.settings.rememberLastPage &&
      typeof state.page === "number" &&
      state.page > 1
    ) {
      // Delay until PDFViewer has laid pages out.
      queueMicrotask(() => {
        this.pdfViewer.currentPageNumber = Math.min(
          this.numPages,
          state.page as number,
        );
      });
    }
  }

  // --- Status bar ---

  private updateStatus(): void {
    this.statusLeft.textContent = `Page ${this.currentPage} / ${this.numPages}`;
    const scale = Math.round(this.pdfViewer.currentScale * 100);
    this.statusRight.textContent = `${scale}%`;
  }

  setStatusCenter(text: string): void {
    this.statusCenter.textContent = text;
  }

  clearStatusCenter(): void {
    this.statusCenter.textContent = "";
  }

  /**
   * Whether find-related events are allowed to write the status center.
   * vim-controller flips this on when opening the search bar and off when
   * the user Escs out, since PDFFindController's reset on `findbarclose`
   * dispatches match-count updates asynchronously and would otherwise
   * repaint the counter after we thought we'd cleared it.
   */
  findStatusEnabled = false;

  setModeLabel(text: string): void {
    const el = document.getElementById("modeIndicator");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("active", text.length > 0);
  }
}

const LAST_SUBDIR_KEY = "vimdf:lastDownloadSubdir";

async function loadLastDownloadSubdir(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(LAST_SUBDIR_KEY);
    const v = r[LAST_SUBDIR_KEY];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

async function saveLastDownloadSubdir(subdir: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_SUBDIR_KEY]: subdir });
  } catch {
    // Non-fatal; next open just re-defaults to "".
  }
}

function isUserCancellation(err: unknown): boolean {
  // Chrome surfaces a dismissed save-as picker as a lastError whose message
  // contains "canceled" (or "interrupted" on some builds). No stable code,
  // so match on the message.
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  return /cancel|interrupt/i.test(msg);
}

function applyTheme(theme: Settings["theme"]): void {
  const klass = resolveThemeClass(theme);
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(klass);
}

function applyCustomStyles(s: Settings): void {
  const r = document.documentElement.style;
  const setOrRemove = (cssVar: string, val: string): void => {
    if (val) r.setProperty(cssVar, val);
    else r.removeProperty(cssVar);
  };
  setOrRemove("--hint-bg", s.hintBg);
  setOrRemove("--hint-fg", s.hintFg);
  setOrRemove("--hint-matched-fg", s.hintMatchedFg);
  setOrRemove("--statusbar-bg", s.statusBarBg);
  setOrRemove("--statusbar-fg", s.statusBarFg);
  const size = Number.isFinite(s.statusBarFontSize) && s.statusBarFontSize > 0
    ? s.statusBarFontSize
    : 12;
  r.setProperty("--statusbar-font-size", `${size}px`);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const file = params.get("file");
  if (!file) {
    document.getElementById("statusLeft")!.textContent =
      "No file specified. Use ?file=<url>";
    return;
  }

  const settings = await loadSettings();
  applyTheme(settings.theme);
  applyCustomStyles(settings);

  const viewer = new Viewer(settings);
  const marks = new MarksStore(file);
  await marks.load();

  const search = new SearchController(viewer);
  const vim = new VimController(viewer, marks, search);
  vim.attach();

  onSettingsChanged((next) => {
    viewer.settings = next;
    vim.updateSettings(next);
    applyTheme(next.theme);
    applyCustomStyles(next);
  });

  // React to system color-scheme changes while theme is "auto".
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => {
      if (viewer.settings.theme === "auto") applyTheme("auto");
    });

  void checkAndShowConflictWarning();

  try {
    await viewer.load(file);
  } catch (err) {
    console.error("Failed to load PDF:", err);
    document.getElementById("statusLeft")!.textContent =
      `Error loading PDF: ${String(err)}`;
  }
}

void main();
