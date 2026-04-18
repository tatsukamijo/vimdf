/**
 * First-run extension-conflict notification for VimDF.
 *
 * Warns the user about other Chrome extensions that hijack PDF URLs before
 * VimDF's declarativeNetRequest redirect can fire (Google Scholar PDF Reader,
 * Xodo, Kami, …). Vim-style keyboard extensions (Vimium, Surfingkeys, …) do
 * NOT need to be listed here: Chrome forbids cross-extension content-script
 * injection, so their keybindings never reach VimDF's viewer page.
 *
 * Shown once per install. The service worker sets `vimdf_show_conflict_warning`
 * on `onInstalled(reason === "install")`; this module consumes and clears it.
 */

import "./conflict-notification.css";

const FLAG_KEY = "vimdf_show_conflict_warning";

export async function checkAndShowConflictWarning(): Promise<void> {
  const r = await chrome.storage.local.get(FLAG_KEY);
  if (!r[FLAG_KEY]) return;
  showConflictWarning();
  await chrome.storage.local.set({ [FLAG_KEY]: false });
}

function showConflictWarning(): void {
  if (document.querySelector(".vimdf-conflict-warning")) return;

  const overlay = document.createElement("div");
  overlay.className = "vimdf-notification-overlay";
  document.body.appendChild(overlay);

  const notification = createWarningElement();
  document.body.appendChild(notification);

  setTimeout(() => {
    overlay.classList.add("vimdf-notification-overlay-visible");
    notification.classList.add("vimdf-notification-visible");
  }, 10);

  const dismissBtn = notification.querySelector(".vimdf-notification-dismiss");
  const gotItBtn = notification.querySelector(".vimdf-notification-got-it");

  const dismiss = (): void => {
    overlay.classList.remove("vimdf-notification-overlay-visible");
    setTimeout(() => overlay.remove(), 300);
    notification.classList.remove("vimdf-notification-visible");
    notification.classList.add("vimdf-notification-hidden");
    setTimeout(() => notification.remove(), 300);
  };

  dismissBtn?.addEventListener("click", dismiss);
  gotItBtn?.addEventListener("click", dismiss);
  overlay.addEventListener("click", dismiss);
}

function createWarningElement(): HTMLElement {
  const el = document.createElement("div");
  el.className = "vimdf-notification vimdf-conflict-warning";
  el.innerHTML = `
    <div class="vimdf-notification-header">
      <div class="vimdf-notification-icon">⚠️</div>
      <div class="vimdf-notification-title">Welcome to VimDF</div>
      <button class="vimdf-notification-dismiss" aria-label="Dismiss">×</button>
    </div>
    <div class="vimdf-notification-body">
      <div class="vimdf-notification-message">
        VimDF replaces Chrome's built-in PDF viewer. A few other
        extensions intercept PDF pages before VimDF can open them.
        If PDFs don't open in VimDF, <strong>disable</strong> these
        (or narrow their scope):
      </div>
      <ul class="vimdf-notification-list">
        <li><strong>Google Scholar PDF Reader</strong> — redirects PDF links to its own viewer.</li>
        <li>Other PDF viewer / annotator extensions (Xodo, Kami, …).</li>
      </ul>
    </div>
    <div class="vimdf-notification-actions">
      <button class="vimdf-notification-got-it">Got it</button>
    </div>
  `;
  return el;
}
