/**
 * Small modal for choosing a download filename. Styled to match the finder
 * (dark, centered, keyboard-driven) so the download flow feels consistent
 * with the rest of the viewer.
 *
 * Quick save (Enter) lands under `~/Downloads` — the only writable root the
 * Chrome downloads API exposes without a picker. Users can type
 * subdirectories ("papers/foo.pdf"); those are created under Downloads.
 * Ctrl+Enter ("save as") instead hands the filename to Chrome's native
 * save dialog, letting the user drop the file anywhere on disk.
 */

export interface SaveDialogOptions {
  defaultName: string;
  initialSubdir: string;
  onConfirm: (filename: string, subdir: string) => void;
  onSaveAs: (filename: string) => void;
  onCancel: () => void;
}

let overlay: HTMLElement | null = null;

export function showSaveDialog(opts: SaveDialogOptions): void {
  closeSaveDialog();

  const root = document.createElement("div");
  root.id = "saveDialog";
  root.innerHTML = `
    <div class="save-box" role="dialog" aria-label="Save PDF">
      <div class="save-header">
        <span class="save-prompt">Save to</span>
        <span class="save-prefix">~/Downloads/</span>
        <input
          type="text"
          class="save-input"
          autocomplete="off"
          spellcheck="false"
          placeholder="filename.pdf"
        />
      </div>
      <div class="save-footer">
        <kbd>↵</kbd> save
        <kbd>^↵</kbd> save as…
        <kbd>Esc</kbd> cancel
        <span class="save-hint">subfolders under ~/Downloads allowed — ^↵ opens a native picker for elsewhere</span>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  overlay = root;

  const input = root.querySelector(".save-input") as HTMLInputElement;
  const initial = joinSubdir(opts.initialSubdir, opts.defaultName);
  input.value = initial;
  input.focus();
  // Select the filename stem (before .pdf) so typing overwrites just the
  // name while keeping any subfolder prefix intact.
  const lastSlash = initial.lastIndexOf("/");
  const nameStart = lastSlash >= 0 ? lastSlash + 1 : 0;
  const dot = initial.lastIndexOf(".");
  const selEnd = dot > nameStart ? dot : initial.length;
  input.setSelectionRange(nameStart, selEnd);

  const handle = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      opts.onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      if (e.ctrlKey || e.metaKey) {
        // Native picker — only the bare filename is meaningful (Chrome's
        // dialog controls the rest). Strip any subdir path the user typed.
        const bare = sanitize(basename(raw));
        if (!bare) return;
        close();
        opts.onSaveAs(bare);
        return;
      }
      const name = sanitize(raw);
      if (!name) return;
      const subdir = dirname(name);
      close();
      opts.onConfirm(name, subdir);
      return;
    }
  };
  input.addEventListener("keydown", handle);

  root.addEventListener("mousedown", (e) => {
    if (e.target === root) {
      close();
      opts.onCancel();
    }
  });

  function close(): void {
    input.removeEventListener("keydown", handle);
    closeSaveDialog();
  }
}

function joinSubdir(subdir: string, name: string): string {
  if (!subdir) return name;
  const clean = subdir.replace(/^\/+|\/+$/g, "");
  return clean ? `${clean}/${name}` : name;
}

function dirname(filepath: string): string {
  const i = filepath.lastIndexOf("/");
  return i >= 0 ? filepath.slice(0, i) : "";
}

function basename(filepath: string): string {
  const i = filepath.lastIndexOf("/");
  return i >= 0 ? filepath.slice(i + 1) : filepath;
}

function closeSaveDialog(): void {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

/**
 * Reject path escapes (leading `/`, `..`) and collapse redundant slashes so
 * the value passed to chrome.downloads.download always stays within
 * ~/Downloads.
 */
function sanitize(raw: string): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  if (!cleaned) return "";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}
