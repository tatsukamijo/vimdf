/**
 * Update toast shown once per version bump.
 *
 * The service worker flips `vimdf_show_update_notification` on
 * `chrome.runtime.onInstalled` with `reason === "update"` and stores the
 * new version. The first viewer page to load after that consumes the flag,
 * shows a bottom-right toast, and clears the flag so it won't fire again.
 */

import "./update-notification.css";

const NOTIFICATION_DURATION = 10000; // 10s, matches vimtion
const GITHUB_RELEASE_URL = "https://github.com/tatsukamijo/vimdf/releases";
const FLAG_KEY = "vimdf_show_update_notification";
const VERSION_KEY = "vimdf_version";

export async function checkAndShowUpdateNotification(): Promise<void> {
  const r = await chrome.storage.local.get([FLAG_KEY, VERSION_KEY]);
  if (!r[FLAG_KEY]) return;
  const version = typeof r[VERSION_KEY] === "string" ? r[VERSION_KEY] : "";
  showUpdateNotification(version);
  await chrome.storage.local.set({ [FLAG_KEY]: false });
}

function showUpdateNotification(version: string): void {
  if (document.querySelector(".vimdf-update-notification")) return;

  const notification = createNotificationElement(version);
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add("vimdf-notification-visible");
  }, 10);

  const autoDismiss = setTimeout(() => {
    dismiss(notification);
  }, NOTIFICATION_DURATION);

  const dismissBtn = notification.querySelector(".vimdf-notification-dismiss");
  const whatsNewBtn = notification.querySelector(
    ".vimdf-notification-whats-new",
  );

  dismissBtn?.addEventListener("click", () => {
    clearTimeout(autoDismiss);
    dismiss(notification);
  });

  whatsNewBtn?.addEventListener("click", () => {
    clearTimeout(autoDismiss);
    window.open(GITHUB_RELEASE_URL, "_blank");
    dismiss(notification);
  });
}

function createNotificationElement(version: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "vimdf-update-notification";
  el.innerHTML = `
    <div class="vimdf-notification-header">
      <div class="vimdf-notification-icon">🎉</div>
      <div class="vimdf-notification-title">VimDF Updated</div>
      <button class="vimdf-notification-dismiss" aria-label="Dismiss">×</button>
    </div>
    <div class="vimdf-notification-body">
      <div class="vimdf-notification-version">${version ? `Version ${escapeHtml(version)}` : "New version installed"}</div>
      <div class="vimdf-notification-message">
        New features and bug fixes available
      </div>
    </div>
    <div class="vimdf-notification-actions">
      <button class="vimdf-notification-whats-new">What's New</button>
    </div>
  `;
  return el;
}

function dismiss(el: HTMLElement): void {
  el.classList.remove("vimdf-notification-visible");
  el.classList.add("vimdf-notification-hidden");
  setTimeout(() => el.remove(), 300);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}
