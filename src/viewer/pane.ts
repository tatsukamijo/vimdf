import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 10;

// Fallback flash dimensions for internal link destinations, which don't carry
// their own extent — the PDF only tells us the target point. Matches the
// outline-section flash so links and sections feel visually consistent.
const LINK_FLASH_HEIGHT_PDF = 14;
const LINK_FLASH_WIDTH_PDF = 400;

const SCALE_PRESETS = new Set([
  "page-width",
  "page-height",
  "page-fit",
  "page-actual",
  "auto",
]);

/** Presets driven by the container's width alone. */
export const WIDTH_PRESETS = new Set(["page-width", "auto"]);

export interface PaneOptions {
  container: HTMLDivElement;
  viewerEl: HTMLDivElement;
  /** 1 renders a selectable text layer (caret mode, search); 0 skips it. */
  textLayerMode: 0 | 1;
  /** Only the main pane searches — a second find controller would extract
   *  the whole document's text a second time for nothing. */
  withFind: boolean;
}

/**
 * One scrollable view onto a PDF: a container, the pdf.js viewer inside it,
 * and everything that moves that view — scrolling, zoom, marks, and the
 * scroll-and-flash used by link and finder jumps.
 *
 * Split out of `Viewer` so a second pane can show the same document at its
 * own position and zoom. Each pane gets its own EventBus and link service
 * (pdf.js binds both to a single viewer), but panes share one
 * PDFDocumentProxy, so the worker parses the file only once.
 */
export abstract class Pane {
  readonly container: HTMLDivElement;
  readonly viewerEl: HTMLDivElement;
  readonly pdfViewer: PDFViewer;
  readonly linkService: PDFLinkService;
  readonly findController: PDFFindController | null;
  readonly eventBus: EventBus;
  /**
   * Last destination passed to PDF.js's scrollPageIntoView. Captured so that
   * post-link-jump features (e.g. caret-mode's initial placement) can land
   * near the citation anchor rather than the viewport midpoint.
   */
  lastJumpDest: { pageIdx: number; xPdf: number | null; yPdf: number | null } | null = null;

  private lastSize = { width: 0, height: 0 };

  constructor(opts: PaneOptions) {
    this.container = opts.container;
    this.viewerEl = opts.viewerEl;

    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      // Don't let dest arrays (outline, named dests, intra-doc links) override
      // the user's current zoom — XYZ/Fit dests with explicit scales otherwise
      // snap the view to page-width on every jump.
      ignoreDestinationZoom: true,
    });
    this.findController = opts.withFind
      ? new PDFFindController({
          eventBus: this.eventBus,
          linkService: this.linkService,
        })
      : null;

    this.pdfViewer = new PDFViewer({
      container: this.container,
      viewer: this.viewerEl,
      eventBus: this.eventBus,
      linkService: this.linkService,
      ...(this.findController ? { findController: this.findController } : {}),
      textLayerMode: opts.textLayerMode,
      annotationEditorMode: -1,
    });
    this.linkService.setViewer(this.pdfViewer);

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


    // pdf.js observes the container only to update a CSS height variable;
    // it never re-fits or re-renders. Splitting, closing a split, and
    // toggling the outline all resize the container, so re-apply a preset
    // zoom (page-width follows the new width) and let pdf.js render pages
    // that just came into view. Height-driven presets (page-fit) re-fit only
    // when the height is unchanged: fitting a whole page into half the
    // height of a stacked split makes it unreadably small.
    new ResizeObserver(() => this.onResize()).observe(this.container);
  }

  private onResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const widthChanged = width !== this.lastSize.width;
    const heightChanged = height !== this.lastSize.height;
    this.lastSize = { width, height };
    if (!(widthChanged || heightChanged) || width === 0 || height === 0) return;
    if (!this.pdfViewer.pdfDocument || this.pdfViewer.pagesCount === 0) return;
    const value = this.pdfViewer.currentScaleValue;
    // Height-driven presets also stay put for the whole life of a stacked
    // split, not just the resize that created it.
    const stacked = document.body.classList.contains("split-horizontal");
    const refit = WIDTH_PRESETS.has(value)
      ? widthChanged
      : SCALE_PRESETS.has(value) && widthChanged && !heightChanged && !stacked;
    if (refit) {
      // pdf.js restores the view after a scale change through
      // scrollPageIntoView, whose override here snaps to the page top and
      // records a jump destination. Neither is a jump: keep what was at the
      // top-left and the last real destination.
      const anchor = this.captureMarkAnchor();
      const lastJump = this.lastJumpDest;
      this.pdfViewer.currentScaleValue = value;
      this.lastJumpDest = lastJump;
      if (anchor) this.restoreMarkAnchor(anchor);
    } else {
      this.pdfViewer.update();
    }
  }

  protected abstract zoomStep(): number;

  /**
   * The zoom to hand to another pane: a width preset as-is, since it re-fits
   * to that pane's width; anything else as the scale shown now, so a
   * height-driven preset like page-fit isn't re-fit into a pane of another
   * height.
   */
  shownScaleValue(): string {
    const value = this.pdfViewer.currentScaleValue;
    return WIDTH_PRESETS.has(value)
      ? value
      : String(this.pdfViewer.currentScale);
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
    const pageEl = this.viewerEl.querySelector(
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
    return this.pdfViewer.pdfDocument?.numPages ?? 0;
  }

  get currentPage(): number {
    return this.pdfViewer.currentPageNumber;
  }

  goToPage(page: number): void {
    const clamped = Math.max(1, Math.min(this.numPages, page));
    this.pdfViewer.currentPageNumber = clamped;
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
    const pageEl = this.viewerEl.querySelector(
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
    this.zoomBy(this.zoomStep());
  }

  zoomOut(): void {
    this.zoomBy(1 / this.zoomStep());
  }

  fitWidth(): void {
    this.pdfViewer.currentScaleValue = "page-width";
  }
}
