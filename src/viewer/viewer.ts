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
import { checkAndShowUpdateNotification } from "./update-notification";
import { downloadPdf, printPdf, suggestedFilename } from "./print";
import { showSaveDialog } from "./save-dialog";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 10;

// Fallback flash dimensions for internal link destinations, which don't carry
// their own extent — the PDF only tells us the target point. Matches the
// outline-section flash so links and sections feel visually consistent.
const LINK_FLASH_HEIGHT_PDF = 14;
const LINK_FLASH_WIDTH_PDF = 400;

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
      // User-initiated link jump (citation click, outline fallback,
      // link-hint): flash the destination and center it in the viewport.
      // Skip zoom-restoration — PDF.js calls us synthetically during zoom
      // with allowNegativeOffset: true, and we mustn't flash or re-center
      // that case. Letting origSPIV run above also keeps PDF.js's internal
      // _location in sync, so subsequent zooms restore to the citation
      // anchor instead of the pre-click position.
      const dest = this.lastJumpDest;
      const isZoomRestore =
        (params as { allowNegativeOffset?: boolean } | undefined)
          ?.allowNegativeOffset === true;
      if (
        params?.destArray &&
        !isZoomRestore &&
        dest &&
        dest.yPdf !== null &&
        params.pageNumber
      ) {
        this.flashScrollToLine(
          params.pageNumber,
          dest.xPdf ?? 0,
          dest.yPdf - LINK_FLASH_HEIGHT_PDF,
          LINK_FLASH_WIDTH_PDF,
          LINK_FLASH_HEIGHT_PDF,
        );
      }
      return ret;
    };

    this.eventBus.on("pagesinit", () => {
      this.pdfViewer.currentScaleValue = this.resolveInitialZoom();
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
    await buildOutline(this.pdfDocument, this.linkService, this);
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

  /**
   * Coerce `settings.initialZoom` to something PDF.js will accept. Presets
   * pass through; numeric strings are clamped to a sane range so a typo'd
   * "5000" can't wreck the viewport.
   */
  private resolveInitialZoom(): string {
    const raw = (this.settings.initialZoom ?? "page-fit").trim();
    const PRESETS = new Set([
      "page-width",
      "page-height",
      "page-fit",
      "page-actual",
      "auto",
    ]);
    if (PRESETS.has(raw)) return raw;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return "page-width";
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, n));
    return String(clamped);
  }

  /**
   * Capture what's at the viewport top-left as a zoom-stable PDF-space
   * anchor. Used by `ma` (set mark): storing container pixel offsets breaks
   * the moment the user zooms, because the scrollable region's total size
   * scales with zoom but the raw offset doesn't.
   *
   * We always anchor to `currentPageNumber` (the page with the most visible
   * area). `convertToPdfPoint` accepts out-of-range page-local Y coords
   * (negative / > pageHeight) just fine — they represent points above /
   * below that page — so this works even when the viewport sits on a
   * page boundary.
   */
  captureMarkAnchor(): {
    page: number;
    xPdf: number;
    yPdf: number;
  } | null {
    const pageIdx = this.currentPage - 1;
    const pv = (this.pdfViewer as unknown as {
      _pages?: Array<{
        div?: HTMLElement;
        viewport?: {
          convertToPdfPoint: (x: number, y: number) => [number, number];
        };
      }>;
    })._pages?.[pageIdx];
    const pageEl = pv?.div;
    const viewport = pv?.viewport;
    if (!pageEl || !viewport) return null;
    const pageRect = pageEl.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    // Page-local viewport coords of the container's top-left corner.
    const vx = containerRect.left - pageRect.left;
    const vy = containerRect.top - pageRect.top;
    const [xPdf, yPdf] = viewport.convertToPdfPoint(vx, vy);
    return { page: pageIdx + 1, xPdf, yPdf };
  }

  /**
   * Inverse of `captureMarkAnchor`: scroll the container so the stored
   * PDF-space anchor lands at the viewport top-left, regardless of current
   * zoom. Legacy marks (no pdf coords, only scrollTop/scrollLeft) fall
   * through to a direct scrollTo — those will still drift after zoom, but
   * the user can re-set them to migrate.
   */
  restoreMarkAnchor(mark: {
    page: number;
    xPdf?: number;
    yPdf?: number;
    scrollTop?: number;
    scrollLeft?: number;
  }): void {
    this.goToPage(mark.page);
    // Two RAFs: page switch + layout settle. Same pattern as
    // `flashScrollToLine` — without this, the page view's viewport isn't
    // reliably available on a cold-page jump.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const hasPdfAnchor =
          typeof mark.xPdf === "number" &&
          typeof mark.yPdf === "number" &&
          Number.isFinite(mark.xPdf) &&
          Number.isFinite(mark.yPdf);
        if (hasPdfAnchor) {
          const pv = (this.pdfViewer as unknown as {
            _pages?: Array<{
              div?: HTMLElement;
              viewport?: {
                convertToViewportPoint: (x: number, y: number) => [number, number];
              };
            }>;
          })._pages?.[mark.page - 1];
          const pageEl = pv?.div;
          const viewport = pv?.viewport;
          if (pageEl && viewport) {
            const [vx, vy] = viewport.convertToViewportPoint(
              mark.xPdf as number,
              mark.yPdf as number,
            );
            const pageRect = pageEl.getBoundingClientRect();
            const containerRect = this.container.getBoundingClientRect();
            const top =
              pageRect.top - containerRect.top + this.container.scrollTop + vy;
            const left =
              pageRect.left -
              containerRect.left +
              this.container.scrollLeft +
              vx;
            const maxTop = Math.max(
              0,
              this.container.scrollHeight - this.container.clientHeight,
            );
            const maxLeft = Math.max(
              0,
              this.container.scrollWidth - this.container.clientWidth,
            );
            this.container.scrollTo({
              top: Math.max(0, Math.min(maxTop, top)),
              left: Math.max(0, Math.min(maxLeft, left)),
              behavior: "auto",
            });
            return;
          }
        }
        // Legacy fallback.
        if (typeof mark.scrollTop === "number") {
          this.container.scrollTo({
            top: mark.scrollTop,
            left: mark.scrollLeft ?? 0,
            behavior: "auto",
          });
        }
      });
    });
  }

  /**
   * Scroll the given PDF-space rectangle (xPdf, yBaseline, widthPdf, heightPdf)
   * so the line is visibly near the top of the viewport, then flash a yellow
   * overlay on it briefly so the user can see exactly which line they landed
   * on.
   *
   * Used by the finder for text hits: dropping the user at page-top after a
   * fuzzy match leaves them scanning a dense page for the matched phrase,
   * whereas positioning the hit in view and flashing it is self-explanatory.
   *
   * We bypass `pdfViewer.scrollPageIntoView` here because the viewer's
   * overridden version re-aligns the target page's top with the container's
   * top (needed for outline/link jumps under our layout), which would undo
   * any Y offset inside the page. Instead we translate the PDF-space line
   * top into container-scroll coordinates and set `scrollTop` directly.
   *
   * Coordinates are in PDF space (origin bottom-left, Y grows upward).
   * `yBaseline` is the baseline of the text line; `heightPdf` is the line's
   * glyph height.
   */
  flashScrollToLine(
    pageNumber: number,
    xPdf: number,
    yBaseline: number,
    widthPdf: number,
    heightPdf: number,
  ): void {
    const clamped = Math.max(1, Math.min(this.numPages, pageNumber));
    const pageIdx = clamped - 1;

    // Ensure the target page is rendered / laid out before we measure.
    // currentPageNumber triggers PDF.js to render nearby pages if needed.
    this.pdfViewer.currentPageNumber = clamped;

    // Two RAFs: first for the page switch / render to settle, second for
    // layout. Without this the viewport isn't reliably available on a
    // cold-page jump.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.performLineScroll(pageIdx, xPdf, yBaseline, heightPdf);
        this.spawnFinderFlash(clamped, xPdf, yBaseline, widthPdf, heightPdf);
      });
    });
  }

  private performLineScroll(
    pageIdx: number,
    xPdf: number,
    yBaseline: number,
    heightPdf: number,
  ): void {
    const pv = (this.pdfViewer as unknown as {
      _pages?: Array<{
        div?: HTMLElement;
        viewport?: {
          convertToViewportPoint: (x: number, y: number) => [number, number];
        };
      }>;
    })._pages?.[pageIdx];
    const pageEl = pv?.div;
    const viewport = pv?.viewport;
    if (!pageEl || !viewport) {
      // Couldn't resolve page geometry — page already at least scrolled into
      // view by the currentPageNumber setter above, so leave it at page top.
      return;
    }

    // Viewport space: (0, 0) is top-left of the page element. PDF space has
    // Y growing upward, so the line's visible top = baseline + height, and
    // its visible bottom = baseline.
    const [, vyLineTop] = viewport.convertToViewportPoint(
      xPdf,
      yBaseline + heightPdf,
    );
    const [, vyLineBottom] = viewport.convertToViewportPoint(xPdf, yBaseline);
    const lineHeightVp = Math.max(8, Math.abs(vyLineBottom - vyLineTop));

    // Translate the line's page-relative Y into container-scroll coordinates.
    // pageEl.getBoundingClientRect().top is relative to the window; subtract
    // container's own top and add current scrollTop to recover the line's
    // absolute offset within the scrollable region.
    const pageRect = pageEl.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();
    const lineTopInScroll =
      pageRect.top - containerRect.top + this.container.scrollTop + vyLineTop;

    // Center the line vertically in the viewport. The hit is what the user
    // just selected; parking it dead-center makes it the most prominent
    // thing on screen and gives equal context above and below.
    const desiredOffset = Math.max(
      0,
      this.container.clientHeight / 2 - lineHeightVp / 2,
    );
    const maxScroll = Math.max(
      0,
      this.container.scrollHeight - this.container.clientHeight,
    );
    const newScrollTop = Math.max(
      0,
      Math.min(maxScroll, lineTopInScroll - desiredOffset),
    );
    this.container.scrollTop = newScrollTop;
  }

  private spawnFinderFlash(
    pageNumber: number,
    xPdf: number,
    yBaseline: number,
    widthPdf: number,
    heightPdf: number,
  ): void {
    const pageView = this.pdfViewer.getPageView(pageNumber - 1) as
      | {
          viewport?: {
            convertToViewportPoint: (x: number, y: number) => [number, number];
          };
        }
      | null;
    const pageEl = document.querySelector(
      `.page[data-page-number="${pageNumber}"]`,
    ) as HTMLElement | null;
    if (!pageView?.viewport || !pageEl) return;

    // PDF Y grows upward; viewport Y grows downward. Line top in PDF space
    // is baseline + height, line bottom is baseline. Converting both gives
    // correctly-ordered viewport Y coords.
    const [vxLeft, vyTop] = pageView.viewport.convertToViewportPoint(
      xPdf,
      yBaseline + heightPdf,
    );
    const [vxRight, vyBottom] = pageView.viewport.convertToViewportPoint(
      xPdf + widthPdf,
      yBaseline,
    );
    const left = Math.min(vxLeft, vxRight);
    const top = Math.min(vyTop, vyBottom);
    const width = Math.max(6, Math.abs(vxRight - vxLeft));
    // Expand the flash a touch so it reads as "this region" rather than
    // "this thin baseline". 4px top/bottom padding plays well with most
    // body text at normal zoom.
    const pad = 3;
    const height = Math.max(8, Math.abs(vyBottom - vyTop)) + pad * 2;

    const flash = document.createElement("div");
    flash.className = "vimdf-finder-flash";
    flash.style.left = `${left - pad}px`;
    flash.style.top = `${top - pad}px`;
    flash.style.width = `${width + pad * 2}px`;
    flash.style.height = `${height}px`;
    pageEl.appendChild(flash);
    setTimeout(() => flash.remove(), 1800);
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
  // Accent color feeds two CSS vars: the hex for solid uses (mode label),
  // and a comma-separated rgb triplet for rgba() composition in the caret
  // and selection overlays. Empty string means fall back to the :root
  // defaults defined in viewer.css.
  setOrRemove("--vim-accent", s.accentColor);
  const rgb = hexToRgb(s.accentColor);
  if (rgb) r.setProperty("--vim-accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  else r.removeProperty("--vim-accent-rgb");
  const size = Number.isFinite(s.statusBarFontSize) && s.statusBarFontSize > 0
    ? s.statusBarFontSize
    : 12;
  r.setProperty("--statusbar-font-size", `${size}px`);
}

function hexToRgb(
  hex: string,
): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3
    ? m[1].split("").map((c) => c + c).join("")
    : m[1];
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
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
  void checkAndShowUpdateNotification();

  try {
    await viewer.load(file);
  } catch (err) {
    console.error("Failed to load PDF:", err);
    document.getElementById("statusLeft")!.textContent =
      `Error loading PDF: ${String(err)}`;
  }
}

void main();
