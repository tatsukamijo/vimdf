/**
 * Thin wrapper over `chrome.mimeHandler` (Chrome 151+), which lets an
 * extension register itself as the browser's handler for a MIME type —
 * `application/pdf` in our case, declared via the `mime_types_handler` key
 * in vite.config.ts.
 *
 * Why VimDF wants this over its declarativeNetRequest redirects:
 *
 *   - **Local PDFs work with nothing to configure.** DNR rules are never
 *     evaluated for `file://` requests unless the user has ticked "Allow
 *     access to file URLs", which is off by default on every Web Store
 *     install. MIME handlers are exempt.
 *   - The address bar keeps the document's real URL.
 *   - Chrome hands over the response it already fetched instead of us
 *     issuing a second request, so single-use URLs and PDFs delivered by
 *     POST survive.
 *
 * None of it is in @types/chrome 0.0.270, so the shapes we use are modelled
 * here. Everything is feature-detected: on Chrome < 151 `chrome.mimeHandler`
 * is simply undefined and the DNR path stays in charge.
 */

export interface StreamInfo {
  mimeType: string;
  /** What the user navigated to — for display and storage identity only. */
  originalUrl: string;
  /** One-shot, extension-origin-only URL carrying the actual bytes. */
  streamUrl: string;
  tabId: number;
  /** True when the PDF sits in an `<embed>`/`<object>`/`<iframe>`. */
  embedded: boolean;
  responseHeaders: Record<string, string>;
}

export interface MimeHandlerOptions {
  enabled: boolean;
}

interface MimeHandlerApi {
  getStreamInfo?: {
    (): Promise<StreamInfo | undefined>;
    (cb: (info?: StreamInfo) => void): void;
  };
  abortAndFallbackToNativeHandler?: {
    (): Promise<boolean>;
    (cb: (ok: boolean) => void): void;
  };
  getMimeHandlerOptions?: (
    mimeType: string,
  ) => Promise<MimeHandlerOptions | undefined>;
  setMimeHandlerOptions?: (
    mimeType: string,
    options: MimeHandlerOptions,
  ) => Promise<void>;
}

export const PDF_MIME_TYPE = "application/pdf";

export function mimeHandler(): MimeHandlerApi | undefined {
  return (chrome as unknown as { mimeHandler?: MimeHandlerApi }).mimeHandler;
}

/** True when this build of Chrome supports MIME-handler registration. */
export function isMimeHandlerSupported(): boolean {
  return mimeHandler()?.getStreamInfo !== undefined;
}

/**
 * The stream this page was opened to render, or null when the page wasn't
 * opened as a MIME handler at all — which is the normal case for the DNR
 * redirect path (`viewer.html?file=…`) and for opening viewer.html by hand.
 */
export async function getStreamInfo(): Promise<StreamInfo | null> {
  const api = mimeHandler();
  if (!api?.getStreamInfo) return null;
  // Chrome ships both a promise and a callback form. Prefer the promise;
  // a callback-only build rejects the zero-argument call during argument
  // validation, so fall through rather than treating that as "no stream".
  try {
    const maybe = api.getStreamInfo();
    if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
      return (await maybe) ?? null;
    }
  } catch {
    // Fall through to the callback form.
  }
  return new Promise((resolve) => {
    try {
      api.getStreamInfo!((info?: StreamInfo) => resolve(info ?? null));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Give the document back to Chrome's built-in viewer. The extension frame is
 * torn down immediately, so treat this as a navigation: nothing after it
 * runs. Only meaningful when this page *is* a MIME-handler frame.
 */
export function abortAndFallbackToNativeHandler(): void {
  const api = mimeHandler();
  if (!api?.abortAndFallbackToNativeHandler) return;
  try {
    const maybe = api.abortAndFallbackToNativeHandler();
    if (maybe && typeof (maybe as Promise<unknown>).then === "function") {
      void (maybe as Promise<boolean>).catch(() => {});
    }
  } catch {
    try {
      api.abortAndFallbackToNativeHandler!(() => {});
    } catch {
      // Not a handler frame; nothing to abort.
    }
  }
}

/** Whether VimDF is currently registered to render PDFs. Defaults to true. */
export async function isPdfHandlingEnabled(): Promise<boolean> {
  const api = mimeHandler();
  if (!api?.getMimeHandlerOptions) return false;
  try {
    return (await api.getMimeHandlerOptions(PDF_MIME_TYPE))?.enabled ?? true;
  } catch {
    return true;
  }
}

export async function setPdfHandlingEnabled(enabled: boolean): Promise<void> {
  const api = mimeHandler();
  if (!api?.setMimeHandlerOptions) return;
  await api.setMimeHandlerOptions(PDF_MIME_TYPE, { enabled });
}

/**
 * Whether the user has granted the "Allow access to file URLs" permission.
 * The only supported way to read that checkbox; there is no way to set it.
 */
export async function isAllowedFileSchemeAccess(): Promise<boolean> {
  try {
    return await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    return false;
  }
}

/**
 * Point the current tab at VimDF's own chrome://extensions card, where the
 * file-access checkbox lives. An extension page can't navigate there itself,
 * so the service worker does it.
 */
export function openExtensionsPage(): void {
  void chrome.runtime.sendMessage({ type: "vimdf.openExtensionsPage" });
}
