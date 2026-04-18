/**
 * Render the loaded PDF to a hidden canvas stack and trigger the browser's
 * print dialog. Mirrors PDF.js's internal `PDFPrintService`: each page is
 * rasterised at print-quality DPI, `@media print` CSS swaps the viewer UI
 * out for the canvas stack, and we clean up on `afterprint`.
 *
 * We can't reuse PDFPrintService directly — it's not part of pdfjs-dist's
 * public exports — but the approach is the same and the output matches
 * what users expect from Chrome's built-in viewer.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

const PRINT_DPI = 150;
const CSS_UNITS = PRINT_DPI / 72;

let inFlight = false;

export async function printPdf(pdfDocument: PDFDocumentProxy): Promise<void> {
  if (inFlight) return;
  inFlight = true;

  // Peek page 1 to size the paper (@page) to the PDF's own dimensions.
  // Without this, the browser falls back to the default Letter/A4 sheet and
  // scales the canvas to fit width — leaving a tall unused strip at the
  // bottom whenever the PDF's aspect ratio differs. PDF.js's PDFPrintService
  // does the same thing.
  const firstPage = await pdfDocument.getPage(1);
  const firstView = firstPage.getViewport({ scale: 1 });
  const pageWidthPt = firstView.width;
  const pageHeightPt = firstView.height;

  const container = document.createElement("div");
  container.id = "vimdfPrintContainer";

  const style = document.createElement("style");
  style.textContent = `
    #vimdfPrintContainer { display: none; }
    #vimdfPrintContainer .vimdf-print-page {
      page-break-after: always;
      page-break-inside: avoid;
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    #vimdfPrintContainer canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    @media print {
      body > *:not(#vimdfPrintContainer) { display: none !important; }
      #vimdfPrintContainer { display: block !important; }
      html, body { background: #fff !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; }
      @page { size: ${pageWidthPt}pt ${pageHeightPt}pt; margin: 0; }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(container);

  const cleanup = (): void => {
    container.remove();
    style.remove();
    window.removeEventListener("afterprint", onAfter);
    inFlight = false;
  };
  const onAfter = (): void => cleanup();
  window.addEventListener("afterprint", onAfter);

  try {
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = i === 1 ? firstPage : await pdfDocument.getPage(i);
      const viewport = page.getViewport({ scale: CSS_UNITS });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;

      const wrap = document.createElement("div");
      wrap.className = "vimdf-print-page";
      // Per-page exact PDF dimensions in pt. When pages differ from the
      // first (@page size), the browser scales this box to fit and the
      // canvas fills it without leaving blank strips.
      const vpPage = page.getViewport({ scale: 1 });
      wrap.style.width = `${vpPage.width}pt`;
      wrap.style.height = `${vpPage.height}pt`;
      wrap.appendChild(canvas);
      container.appendChild(wrap);
    }
    // Let layout settle before invoking print.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    window.print();
    // Safari/Chrome both fire afterprint; if somehow not, fallback cleanup.
    setTimeout(() => {
      if (inFlight) cleanup();
    }, 60_000);
  } catch (err) {
    console.error("print failed:", err);
    cleanup();
  }
}

export interface DownloadOptions {
  /** Path relative to ~/Downloads. Ignored when saveAs is true. */
  filename: string;
  /** Open Chrome's native save dialog so the user can pick any location. */
  saveAs?: boolean;
}

export async function downloadPdf(
  pdfDocument: PDFDocumentProxy,
  opts: DownloadOptions,
): Promise<void> {
  const data = await pdfDocument.getData();
  // Copy into a fresh ArrayBuffer to satisfy BlobPart typing regardless of
  // the underlying buffer type PDF.js returns.
  const buf = new Uint8Array(data.byteLength);
  buf.set(data);
  const blob = new Blob([buf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  try {
    // Prefer chrome.downloads: it respects the filename exactly (including
    // subdirectories like "papers/foo.pdf") and supports `saveAs: true` to
    // open the OS native save-as picker, which is the only way to write
    // outside ~/Downloads from an extension. Falls back to the <a download>
    // trick if the API is unavailable for some reason.
    if (chrome?.downloads?.download) {
      await new Promise<void>((resolve, reject) => {
        chrome.downloads.download(
          { url, filename: opts.filename, saveAs: opts.saveAs === true },
          (id) => {
            const err = chrome.runtime.lastError;
            if (err || id === undefined) {
              reject(err ?? new Error("download failed"));
            } else {
              resolve();
            }
          },
        );
      });
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = opts.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } finally {
    // Revoke after the browser has had a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function suggestedFilename(pdfUrl: string): string {
  try {
    const u = new URL(pdfUrl);
    const last = decodeURIComponent(u.pathname.split("/").pop() ?? "");
    if (last) {
      return last.toLowerCase().endsWith(".pdf") ? last : `${last}.pdf`;
    }
  } catch {
    // Non-URL input, fall through.
  }
  return "document.pdf";
}
