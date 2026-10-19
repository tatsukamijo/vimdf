import "pdfjs-dist/web/pdf_viewer.css";
import "./viewer.css";

import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import type { PDFFindController } from "pdfjs-dist/web/pdf_viewer.mjs";

import { MAX_SCALE, MIN_SCALE, Pane } from "./pane";
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
import {
  abortAndFallbackToNativeHandler,
  getStreamInfo,
  isAllowedFileSchemeAccess,
} from "./mime-handler";
import {
  closeLocalFilePanel,
  displayPath,
  enableDropToOpen,
  showLocalFilePanel,
} from "./local-file";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

/**
 * Where a document's bytes come from, and what to call it.
 *
 * `url` and `data` are the two ways pdf.js can be fed; `identity` is kept
 * separate from both because the thing we read is not always the thing the
 * user navigated to. A `chrome.mimeHandler` stream URL is single-use and
 * internal, and a file chosen from the picker has no URL whatsoever — but
 * both should still resolve to the same marks, highlights and last page as
 * the original document.
 */
export interface PdfSource {
  url?: string;
  data?: ArrayBuffer;
  identity: string;
}

/**
 * The main pane, plus everything that belongs to the document as a whole:
 * loading, highlights, persisted reading position, and the status bar.
 */
export class Viewer extends Pane {
  // The main pane always searches, so narrow the base class's nullable type.
  declare readonly findController: PDFFindController;

  pdfDocument: PDFDocumentProxy | null = null;
  pdfUrl: string = "";
  settings: Settings;

  /** The pane the status bar reports on: the focused one while split. */
  statusPane: Pane = this;

  // Other panes showing this document. They borrow `pdfDocument`, so they
  // are closed before it is destroyed, and they draw highlights too.
  private secondaryPanes = new Set<Pane & { close(): void }>();

  private highlightStore: HighlightStore | null = null;
  private userHighlights: Highlight[] = [];

  get highlights(): ReadonlyArray<Highlight> {
    return this.userHighlights;
  }

  private statusLeft = document.getElementById("statusLeft")!;
  private statusCenter = document.getElementById("statusCenter")!;
  private statusRight = document.getElementById("statusRight")!;

  private saveDebounceTimer: number | null = null;

  constructor(settings: Settings) {
    super({
      container: document.getElementById("viewerContainer") as HTMLDivElement,
      viewerEl: document.getElementById("viewer") as HTMLDivElement,
      textLayerMode: 1,
      withFind: true,
    });
    this.settings = settings;

    this.eventBus.on("pagesinit", () => {
      this.pdfViewer.currentScaleValue = this.resolveInitialZoom();
      this.updateStatus();
    });

    this.eventBus.on("pagechanging", () => {
      this.updateStatus();
      this.scheduleSave();
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

    // Persist within-page scroll position too (debounced). Without this,
    // livereload reloads — where the iframe just re-navigates with no
    // beforeunload to flush state — lose the offset even after the storage
    // key normalization treats the new `?t=…` URL as the same document.
    this.container.addEventListener(
      "scroll",
      () => this.scheduleSave(),
      { passive: true },
    );
  }

  async load(src: PdfSource): Promise<void> {
    // Identity, not necessarily what we read from: a MIME-handler stream URL
    // is one-shot and internal, and a picked file has no URL at all. Keying
    // storage on the navigated URL keeps marks and last-page attached to the
    // document however its bytes reached us.
    this.pdfUrl = src.identity;
    const isHttp = /^https?:/i.test(src.url ?? "");
    const loadingTask = getDocument({
      ...(src.data !== undefined ? { data: src.data } : { url: src.url! }),
      cMapUrl: chrome.runtime.getURL("cmaps/"),
      cMapPacked: true,
      // Forward cookies on the cross-origin fetch so cookie-authenticated
      // signed URLs work (Notion attachments, Drive previews, etc). Without
      // this the request goes out anonymously and gets a 4xx from anything
      // behind a session check. Safe for unauthenticated PDFs too — just
      // sets the credentials mode on the underlying fetch. Scoped to http(s)
      // because it means nothing on the file:// and in-memory paths.
      withCredentials: isHttp,
    });
    // Swapping documents in place (a dropped or picked file replacing what's
    // on screen) — release the old one only once pdf.js has stopped
    // referencing it, or its in-flight render tasks throw.
    const previous = this.pdfDocument;
    this.pdfDocument = await loadingTask.promise;
    this.pdfViewer.setDocument(this.pdfDocument);
    this.linkService.setDocument(this.pdfDocument, null);
    for (const pane of this.secondaryPanes) pane.close();
    if (previous) void previous.destroy().catch(() => {});

    this.highlightStore = new HighlightStore(src.identity);
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

  protected zoomStep(): number {
    return this.settings.zoomStep;
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

  addSecondaryPane(pane: Pane & { close(): void }): void {
    this.secondaryPanes.add(pane);
  }

  removeSecondaryPane(pane: Pane): void {
    this.secondaryPanes.delete(pane as Pane & { close(): void });
    if (this.statusPane === pane) this.statusPane = this;
    this.updateStatus();
  }

  private renderHighlightsForPage(pageIdx: number): void {
    this.renderHighlightsIn(this, pageIdx);
    for (const pane of this.secondaryPanes) {
      this.renderHighlightsIn(pane, pageIdx);
    }
  }

  renderHighlightsIn(pane: Pane, pageIdx: number): void {
    const pageEl = pane.viewerEl.querySelector(
      `.page[data-page-number="${pageIdx + 1}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return;
    renderHighlightsForPage(pageEl, pageIdx, this.userHighlights, (id) => {
      void this.removeHighlight(id);
    });
  }

  // --- Persistence ---

  // Cache-busting query params used by common livereload watchers. The
  // storage key strips these so `paper.pdf?t=1747999123456` is treated as
  // the same document across reloads — otherwise every recompile would
  // land on a brand-new key and revert to page 1.
  private static readonly CACHE_BUST_PARAMS = ["t", "_", "v", "cb", "ts", "r"];

  private static storageUrl(url: string): string {
    try {
      const u = new URL(url, location.href);
      for (const p of Viewer.CACHE_BUST_PARAMS) u.searchParams.delete(p);
      u.hash = "";
      return u.toString();
    } catch {
      // blob:, data:, or otherwise non-parseable — use as-is.
      return url;
    }
  }

  private storageKey(): string {
    return `vimdf:state:${Viewer.storageUrl(this.pdfUrl)}`;
  }

  private async saveState(): Promise<void> {
    if (!this.pdfUrl) return;
    const key = this.storageKey();
    const existing = await chrome.storage.local.get(key);
    const prev = (existing[key] ?? {}) as {
      page?: number;
      scrollTop?: number;
    };
    const next: typeof prev = { ...prev };
    if (this.settings.rememberLastPage) {
      next.page = this.currentPage;
      next.scrollTop = this.container.scrollTop;
    }
    await chrome.storage.local.set({ [key]: next });
  }

  /**
   * Trailing-debounced save. Both pagechanging and the container's `scroll`
   * event funnel through here — 150 ms after the last one fires, persist
   * page + scrollTop. Short enough that the watcher's recompile→reload
   * window (~hundreds of ms) almost always catches the latest position;
   * long enough that continuous scrolling doesn't hammer chrome.storage.
   */
  private scheduleSave(): void {
    if (!this.settings.rememberLastPage) return;
    if (this.saveDebounceTimer !== null) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.saveState();
    }, 150);
  }

  private async restoreState(): Promise<void> {
    if (!this.pdfUrl) return;
    const key = this.storageKey();
    const result = await chrome.storage.local.get(key);
    const state = result[key] as
      | { page?: number; scrollTop?: number }
      | undefined;
    if (!state || !this.settings.rememberLastPage) return;
    const hasPage = typeof state.page === "number" && state.page > 1;
    const hasScroll =
      typeof state.scrollTop === "number" && state.scrollTop > 0;
    if (!hasPage && !hasScroll) return;
    // Microtask: wait until PDFViewer has the document set. RAF: let PDF.js's
    // own page-set scroll settle first, then snap scrollTop authoritatively
    // so a livereload restores the exact previous offset, not the top of the
    // saved page.
    queueMicrotask(() => {
      if (hasPage) {
        this.pdfViewer.currentPageNumber = Math.min(
          this.numPages,
          state.page as number,
        );
      }
      if (hasScroll) {
        requestAnimationFrame(() => {
          this.container.scrollTop = state.scrollTop as number;
        });
      }
    });
  }

  // --- Status bar ---

  updateStatus(): void {
    const pane = this.statusPane;
    this.statusLeft.textContent = `Page ${pane.currentPage} / ${this.numPages}`;
    const scale = Math.round(pane.pdfViewer.currentScale * 100);
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

// The server answered, but not with usable PDF bytes — an HTML interstitial
// (Cloudflare "are you a robot?", a login wall), a 404 page, an error page.
// These are exactly the responses the browser should render natively so the
// user can act on them; pdf.js names them distinctly from network aborts.
function isNotAPdfResponse(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return (
    name === "InvalidPDFException" ||
    name === "MissingPDFException" ||
    name === "UnexpectedResponseException"
  );
}

/** Last path segment of a URL, percent-decoded, for comparing against a
 *  picked File's `name`. */
function basename(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

// Ask the service worker to stand down for `file`, then re-navigate so the
// browser renders whatever the server is actually serving (bot-check
// challenge, login page, …). Once that's dealt with, the next load of the
// URL is intercepted normally again. sessionStorage is per-tab and survives
// the navigation away and back, so it guards against bouncing in a loop
// when the URL keeps serving non-PDF content.
async function requestNativeBypass(file: string): Promise<boolean> {
  // Meaningless for local files: there is no server to render an alternative
  // response, and with file access denied the re-navigation is blocked
  // anyway, leaving a blank page. The service worker refuses these too.
  if (file.startsWith("file:")) return false;
  const guardKey = `vimdf_bypassed:${file}`;
  const last = Number(sessionStorage.getItem(guardKey) ?? 0);
  if (Date.now() - last < 30_000) return false;
  let ok = false;
  try {
    ok =
      (await chrome.runtime.sendMessage({
        type: "vimdf.bypass",
        url: file,
      })) === true;
  } catch {
    ok = false;
  }
  if (!ok) return false;
  sessionStorage.setItem(guardKey, String(Date.now()));
  location.replace(file);
  return true;
}

/**
 * Work out what this page was opened to render.
 *
 * Two mechanisms can land a user here, and they're checked in this order:
 *
 *   1. **The declarativeNetRequest redirect** — `viewer.html?file=<url>`.
 *      The original URL is pasted in verbatim, with no percent-encoding of
 *      its `?`, `&` or `=`, because DNR's `\0` substitution doesn't re-encode.
 *      URLSearchParams would split on the first `&` inside that URL and
 *      silently truncate the rest (Notion's signed attachment URLs carry
 *      `?table=block&id=…&spaceId=…&userId=…&cache=v2` and would lose all
 *      but `table`, returning HTTP 400), so the value is taken as the raw
 *      tail of the search string instead.
 *   2. **`chrome.mimeHandler`** (Chrome 151+) — no query string at all;
 *      Chrome hands us the already-fetched response. This is the path local
 *      PDFs take, since it needs no file-scheme grant.
 *
 * `chrome.mimeHandler` exists on 151+ regardless of how we were opened, so
 * the query string has to be checked first: a DNR-redirected page is not a
 * handler frame and has no stream to ask for.
 */
type Resolved =
  | { kind: "source"; source: PdfSource }
  /** Nothing to render, and nothing to offer — viewer.html opened bare. */
  | { kind: "none" }
  /** Deliberately given back to Chrome's viewer; this frame is going away. */
  | { kind: "handed-back" };

async function resolveSource(): Promise<Resolved> {
  const m = location.search.match(/^\?file=(.*)$/);
  if (m) return { kind: "source", source: { url: m[1], identity: m[1] } };

  const stream = await getStreamInfo();
  if (!stream) return { kind: "none" };

  // Registering as the PDF MIME handler means Chrome routes *every* PDF here,
  // including ones the DNR rules deliberately let through. A response the
  // server marked as a download is the case that matters: those are often
  // one-shot endpoints, and the user asked for a file on disk, not a viewer.
  // Hand it straight back — `excludedResponseHeaders` on the Content-Type
  // rule below makes the same call for the redirect path.
  const disposition = headerValue(stream.responseHeaders, "content-disposition");
  if (/^\s*attachment/i.test(disposition)) {
    abortAndFallbackToNativeHandler();
    return { kind: "handed-back" };
  }

  // The stream URL may be fetched exactly once, so read it to completion
  // here rather than handing it to pdf.js, which would range-request it.
  try {
    const data = await (await fetch(stream.streamUrl)).arrayBuffer();
    return { kind: "source", source: { data, identity: stream.originalUrl } };
  } catch (err) {
    // We've consumed our one shot at the bytes and have nothing to show.
    // Chrome's own viewer can still re-request the document, so give it back
    // rather than leaving the user on a blank page where the built-in viewer
    // used to work.
    console.error("VimDF: failed to read MIME handler stream:", err);
    abortAndFallbackToNativeHandler();
    return { kind: "handed-back" };
  }
}

/** Case-insensitive lookup over `StreamInfo.responseHeaders`. */
function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return v;
  }
  return "";
}

async function main(): Promise<void> {
  const resolved = await resolveSource();
  // The frame is being torn down by Chrome; don't paint anything over it.
  if (resolved.kind === "handed-back") return;
  const source = resolved.kind === "source" ? resolved.source : null;

  const settings = await loadSettings();
  applyTheme(settings.theme);
  applyCustomStyles(settings);

  const viewer = new Viewer(settings);
  const marks = new MarksStore(source?.identity ?? "");
  await marks.load();

  const search = new SearchController(viewer);
  const vim = new VimController(viewer, marks, search);
  vim.attach();

  // If we're embedded as a sub-frame, ask our content script in the parent
  // page to focus this iframe — cross-origin iframes can't grab focus on
  // themselves, so keys go to the host page's body until the user clicks
  // the PDF. Top-level PDF tabs (no parent) skip this.
  if (window.parent !== window) {
    window.parent.postMessage("vimdf:loaded", "*");
  }

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

  // Reading a file the user hands us directly needs no permission of any
  // kind, so this doubles as the recovery path for every local-file failure
  // below and as a general "open a PDF" gesture.
  //
  // `expected` is the file:// URL we were *asked* for, when recovering one.
  // Matching it back up keeps marks, highlights and last-page attached to the
  // document; any other file is its own document, keyed by name and size
  // because a picked File carries no path.
  const openFile = async (picked: File, expected?: string): Promise<void> => {
    const identity =
      expected && basename(expected) === picked.name
        ? expected
        : // Shaped as a URL, not an opaque string, so the machinery that
          // derives the window title and the Ctrl-S filename from a pathname
          // keeps working. Size disambiguates same-named files.
          `vimdf-local:///${picked.size}/${encodeURIComponent(picked.name)}`;
    closeLocalFilePanel();
    try {
      const data = await picked.arrayBuffer();
      await marks.retarget(identity);
      await viewer.load({ data, identity });
    } catch (err) {
      document.getElementById("statusLeft")!.textContent =
        `Error reading ${picked.name}: ${String(err)}`;
    }
  };
  enableDropToOpen((picked) => void openFile(picked));

  if (!source) {
    // No `?file=` and no MIME-handler stream — viewer.html was opened on its
    // own. Offer the picker rather than a dead end.
    showLocalFilePanel({
      reason: "no-document",
      onPick: (picked) => void openFile(picked),
    });
    return;
  }

  const file = source.identity;
  const isLocal = file.startsWith("file:");

  try {
    await viewer.load(source);
  } catch (err) {
    console.error("Failed to load PDF:", err);
    if (isLocal) {
      // Every local read failure — permission denied, moved, deleted —
      // reaches us as MissingPDFException, which `isNotAPdfResponse` would
      // otherwise read as "the server sent an interstitial" and bounce out
      // to Chrome's native viewer with no message at all. There is no server
      // behind a file:// URL; say what actually went wrong and offer the
      // picker, which works whatever the permission state.
      const granted = await isAllowedFileSchemeAccess();
      showLocalFilePanel({
        reason: granted ? "unreadable" : "no-access",
        fileUrl: file,
        onPick: (picked) => void openFile(picked, file),
      });
      document.getElementById("statusLeft")!.textContent = granted
        ? `Can't read ${displayPath(file)}`
        : "No access to local files";
      return;
    }
    if (isNotAPdfResponse(err)) {
      // Hand the URL back to the browser so the interstitial / error page
      // the server is actually serving can render (and be acted on).
      //
      // Top-level tabs only. An embedded viewer (LaTeX livereload iframe)
      // hits this path with every half-written PDF mid-compile, and a
      // bypassed iframe navigation never fires tabs.onUpdated — the allow
      // rule would strand the document in Chrome's native viewer for every
      // reload after. There the transient error message *is* the right
      // outcome: the next recompile reload lands back in VimDF.
      const topLevel = window.parent === window;
      if (topLevel && (await requestNativeBypass(file))) return;
      document.getElementById("statusLeft")!.textContent =
        `Error loading PDF: ${String(err)} — the server answered with ` +
        "something that isn't a PDF (login or bot check?). Reload to retry.";
      return;
    }
    document.getElementById("statusLeft")!.textContent =
      `Error loading PDF: ${String(err)}`;
  }
}

void main();
