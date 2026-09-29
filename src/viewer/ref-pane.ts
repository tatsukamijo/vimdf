import type { PDFDocumentProxy } from "pdfjs-dist";
import { Pane } from "./pane";
import type { Viewer } from "./viewer";

/** `vertical` puts the panes side by side (Vim's :vsplit); `horizontal`
 *  stacks them (:split). */
export type SplitDirection = "vertical" | "horizontal";

const SPLIT_CLASSES: Record<SplitDirection, string> = {
  vertical: "split-vertical",
  horizontal: "split-horizontal",
};

/**
 * A second view onto the open document, for keeping a figure, table or
 * equation in sight while reading elsewhere.
 *
 * It shares the main pane's PDFDocumentProxy, so opening it costs rendering
 * only, not a second parse. It deliberately skips the text layer: caret
 * mode, search and link hints stay with the main pane, and the reference
 * pane only scrolls, zooms and jumps.
 */
export class RefPane extends Pane {
  private direction: SplitDirection | null = null;
  // Bumped on every open and close, so an open still waiting on pdf.js can
  // tell it has been superseded.
  private generation = 0;

  constructor(private main: Viewer) {
    super({
      container: document.getElementById("refContainer") as HTMLDivElement,
      viewerEl: document.getElementById("refViewer") as HTMLDivElement,
      textLayerMode: 0,
      withFind: false,
    });
    this.eventBus.on("pagechanging", () => main.updateStatus());
    this.eventBus.on("scalechanging", () => main.updateStatus());
    this.eventBus.on("pagerendered", (e: { pageNumber: number }) => {
      main.renderHighlightsIn(this, e.pageNumber - 1);
    });
  }

  get isOpen(): boolean {
    return this.direction !== null;
  }

  get splitDirection(): SplitDirection | null {
    return this.direction;
  }

  protected zoomStep(): number {
    return this.main.settings.zoomStep;
  }

  /**
   * Show the pane at the main pane's current position and zoom, the way
   * Vim's :split starts both windows on the same view. If it is already
   * open, only the orientation changes.
   */
  async open(direction: SplitDirection): Promise<void> {
    const doc = this.main.pdfDocument;
    if (!doc) return;
    if (this.isOpen) {
      this.setLayout(direction);
      return;
    }
    // Capture before the layout change: shrinking the main pane can refit
    // its zoom and move what is at its top-left corner.
    const anchor = this.main.captureMarkAnchor();
    const scale = this.main.shownScaleValue();
    const gen = ++this.generation;
    this.setLayout(direction);
    this.main.addSecondaryPane(this);

    const ready = new Promise<void>((resolve) => {
      this.eventBus.on("pagesinit", () => resolve(), { once: true });
    });
    this.pdfViewer.setDocument(doc);
    this.linkService.setDocument(doc, null);
    await ready;
    if (gen !== this.generation) return;
    this.pdfViewer.currentScaleValue = scale;
    if (anchor) this.restoreMarkAnchor(anchor);
    this.main.updateStatus();
  }

  close(): void {
    if (!this.isOpen) return;
    const gen = ++this.generation;
    this.setLayout(null);
    this.main.removeSecondaryPane(this);
    // Drop the document so the pane's rendered pages are freed; the shared
    // proxy itself belongs to the main pane and stays alive. pdf.js accepts
    // null here (it tears the view down) though its typings don't say so.
    const release = (): void => {
      if (gen !== this.generation) return; // reopened meanwhile
      this.pdfViewer.setDocument(null as unknown as PDFDocumentProxy);
      this.linkService.setDocument(null, null);
    };
    // Not while pdf.js is still creating page views: that loop indexes the
    // page list unguarded, and with the shared document still alive its
    // pending getPage calls resolve into an emptied list and throw.
    const pages = this.pdfViewer.pagesPromise as Promise<void> | null;
    if (pages) pages.then(release, release);
    else release();
  }

  private setLayout(direction: SplitDirection | null): void {
    this.direction = direction;
    const body = document.body.classList;
    for (const [dir, klass] of Object.entries(SPLIT_CLASSES)) {
      body.toggle(klass, dir === direction);
    }
    this.container.hidden = direction === null;
  }
}
