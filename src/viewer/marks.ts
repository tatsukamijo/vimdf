export interface MarkPosition {
  page: number;
  // PDF-space anchor of whatever was at the viewport top-left when the mark
  // was set. Zoom-stable — computed via `viewport.convertToPdfPoint` at set
  // time and inverted via `convertToViewportPoint` at jump time.
  xPdf?: number;
  yPdf?: number;
  // Legacy container-pixel offsets. Old marks saved before PDF-space anchors
  // landed still carry these; we fall back to them when pdf coords are
  // missing, with the caveat that they drift after zoom (the bug that led
  // to the new scheme).
  scrollTop?: number;
  scrollLeft?: number;
}

type MarkMap = Record<string, MarkPosition>;

export class MarksStore {
  private marks: MarkMap = {};

  constructor(private pdfUrl: string) {}

  private get key(): string {
    return `vimdf:marks:${this.pdfUrl}`;
  }

  async load(): Promise<void> {
    const result = await chrome.storage.local.get(this.key);
    this.marks = (result[this.key] as MarkMap | undefined) ?? {};
  }

  /**
   * Point at a different document and reload its marks. Used when the viewer
   * swaps documents in place rather than navigating — dropping a PDF onto the
   * window, or picking one from the local-file prompt — which would otherwise
   * keep writing the new document's marks under the old document's key.
   */
  async retarget(pdfUrl: string): Promise<void> {
    this.pdfUrl = pdfUrl;
    await this.load();
  }

  set(name: string, pos: MarkPosition): void {
    this.marks[name] = pos;
    void chrome.storage.local.set({ [this.key]: this.marks });
  }

  get(name: string): MarkPosition | undefined {
    return this.marks[name];
  }

  all(): Readonly<MarkMap> {
    return this.marks;
  }
}
