/**
 * The screen a user lands on when VimDF has a local PDF to show but can't
 * read it — plus the "open a local PDF" entry point when viewer.html is
 * visited with nothing to render.
 *
 * Background: on Chrome < 151 the only way an extension may touch a
 * `file://` URL is the per-extension "Allow access to file URLs" checkbox,
 * which is off by default for every Web Store install and can't be requested
 * programmatically. Chrome 151+ makes this moot — VimDF registers as the
 * PDF MIME handler and Chrome hands it the bytes directly — so this panel is
 * only reached on older builds, or when a local file genuinely can't be read.
 *
 * Either way the file picker below is a complete escape hatch: choosing the
 * file hands us a File object with no permission involved at all, and the
 * caller keeps using the original `file://` URL as the document's identity,
 * so marks, highlights and last-page all persist exactly as if VimDF had
 * opened it directly.
 */

import { openExtensionsPage } from "./mime-handler";

export type LocalFileReason =
  /** A file:// PDF we were asked to open, without file-scheme access. */
  | "no-access"
  /** File access is granted but the read still failed (moved? deleted?). */
  | "unreadable"
  /** viewer.html opened with no document at all. */
  | "no-document";

export interface LocalFilePanelOptions {
  reason: LocalFileReason;
  /** The file:// URL we were trying to open, when there is one. */
  fileUrl?: string;
  /** Called with the user's chosen file. */
  onPick: (file: File) => void;
}

let panel: HTMLElement | null = null;

export function closeLocalFilePanel(): void {
  panel?.remove();
  panel = null;
}

/** Human-readable path for display: strip the scheme, undo %20 and friends. */
export function displayPath(fileUrl: string): string {
  try {
    return decodeURIComponent(new URL(fileUrl).pathname);
  } catch {
    return fileUrl;
  }
}

export function showLocalFilePanel(opts: LocalFilePanelOptions): void {
  closeLocalFilePanel();

  const root = document.createElement("div");
  root.id = "localFilePanel";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Open a local PDF");

  const name = opts.fileUrl ? displayPath(opts.fileUrl) : "";
  const heading =
    opts.reason === "no-document"
      ? "Open a local PDF"
      : opts.reason === "unreadable"
        ? "Couldn't read that file"
        : "VimDF needs permission to read local files";

  const blurb =
    opts.reason === "no-document"
      ? "Choose a PDF from your computer, or drop one anywhere on this page."
      : opts.reason === "unreadable"
        ? "The file may have been moved, renamed or deleted since the link was made. Pick it again to carry on."
        : "Chrome only lets an extension read <code>file://</code> URLs after you tick a box that is off by default. Grant it once and every local PDF opens in VimDF from then on — or just pick this one file now.";

  root.innerHTML = `
    <div class="lf-box">
      <h1>${heading}</h1>
      ${name ? `<p class="lf-path" title="${escapeAttr(name)}">${escapeHtml(name)}</p>` : ""}
      <p class="lf-blurb">${blurb}</p>
      ${
        opts.reason === "no-access"
          ? `<div class="lf-grant">
               <button type="button" id="lfGrant">Open VimDF's extension settings</button>
               <p class="lf-note">
                 Turn on <b>Allow access to file URLs</b>, then reopen the PDF.
                 Chrome reloads VimDF when you flip it, so this tab will close.
               </p>
             </div>`
          : ""
      }
      <div class="lf-pick">
        <label class="lf-pick-btn" for="lfInput">Choose a PDF…</label>
        <input type="file" id="lfInput" accept="application/pdf,.pdf" />
        <p class="lf-note">Or drop a PDF anywhere on this page.</p>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  panel = root;

  root.querySelector("#lfGrant")?.addEventListener("click", () => {
    openExtensionsPage();
  });

  const input = root.querySelector("#lfInput") as HTMLInputElement;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) opts.onPick(file);
  });
  // Focus the picker so Space/Enter opens it without reaching for the mouse.
  (root.querySelector(".lf-pick-btn") as HTMLElement | null)?.focus();
}

/**
 * Accept a PDF dropped anywhere on the viewer, whether or not the panel is
 * up. This is a plain File read on our own extension page — it never
 * navigates to the dropped path, so it is unaffected by file-scheme access.
 */
export function enableDropToOpen(onPick: (file: File) => void): void {
  const isPdf = (f: File): boolean =>
    f.type === "application/pdf" || /\.pdf$/i.test(f.name);

  // Both handlers must preventDefault or the browser navigates to the file
  // and replaces the viewer with Chrome's own PDF display.
  window.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    document.body.classList.add("vimdf-dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("vimdf-dragging");
  });
  window.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    // Always swallow a file drop, PDF or not. Having accepted the drag above,
    // letting the default through would navigate the tab to whatever was
    // dropped and throw away the document currently on screen.
    e.preventDefault();
    document.body.classList.remove("vimdf-dragging");
    const file = Array.from(e.dataTransfer.files).find(isPdf);
    if (file) onPick(file);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
