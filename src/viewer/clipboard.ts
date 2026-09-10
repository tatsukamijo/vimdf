// Copying text out of the viewer, including from frames where the modern
// Clipboard API is switched off before our code ever runs.
//
// Publisher sites don't serve a PDF as a top-level document — they serve an
// HTML shell whose entire body is one full-viewport iframe pointing at the
// PDF. IEEE Xplore is the canonical case: `/stamp/stamp.jsp?...` returns
// `text/html` wrapping `<iframe src=".../stampPDF/getPDF.jsp?...">`, and it
// is that sub-frame response that carries `content-type: application/pdf`.
// Our redirect rules all list SUB_FRAME alongside MAIN_FRAME, so the
// Content-Type catch-all fires there and `viewer.html?file=…` commits
// *inside* IEEE's iframe. It looks like an ordinary PDF tab; structurally
// it's a chrome-extension:// document whose parent is a web origin.
//
// That position is exactly where `navigator.clipboard.writeText()` is
// disabled. Blink gates it on the `clipboard-write` permissions-policy
// feature, whose default allowlist is `'self'` — which the spec defines as
// *disallowed* in a child frame cross-origin to its parent. An iframe's
// container policy defaults to its `src` origin, and IEEE's iframe carries
// no `allow` attribute, so nothing grants the feature back and the promise
// rejects with `NotAllowedError: The Clipboard API has been blocked because
// of a permissions policy applied to the current document`. IEEE never had
// to deny anything; only the *embedder* can grant it, and it didn't.
//
// No manifest permission fixes this. The policy check runs in the renderer
// and returns early, before any browser-side extension-permission lookup —
// `clipboardWrite` would only waive the transient-activation requirement,
// which a `y` keypress already satisfies.
//
// `document.execCommand("copy")` reaches the clipboard through a different
// path entirely: Blink's editing commands, which carry no permissions-policy
// check at all and allow a script-initiated copy on transient user
// activation alone. It doesn't consult `document.hasFocus()` either, so it
// also covers a viewer that never received focus. This is the same
// machinery Chrome's own PDF viewer copies through, which is why that
// extension declares no clipboard permission either. It is deprecated on
// paper and load-bearing in practice: do not "modernise" it away — deleting
// it silently breaks yanking on every publisher site.
//
// If Chrome ever does remove it, the escape hatch is a real DOM Selection
// (or a readonly <textarea> for visual-block, which no single Range can
// express) plus a prompt to press ⌘C: a genuine keyboard copy reaches Blink
// as a menu/key-binding command, which is allowed unconditionally. Not
// built while the rung below works, since it costs a dialog, its CSS and a
// mode-state machine that would all be dead code.

// Latched once a rejection blames the permissions policy. That's a property
// of this document's position in the frame tree, and the viewer never
// re-navigates — drag-and-drop and the local-file panel swap the document
// in place — so it cannot come untrue later. Deliberately not latched for
// "Document is not focused", which clears the moment the user clicks in.
let asyncBlocked = false;

/**
 * Put `text` on the system clipboard. Returns whether it landed.
 *
 * Must be called synchronously from a user-gesture handler (a keydown):
 * the fallback rung spends that gesture's transient activation.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (!asyncBlocked && policyMayAllowAsync()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      const e = err as DOMException;
      if (/permissions policy/i.test(e?.message ?? "")) asyncBlocked = true;
      console.warn(
        `VimDF: navigator.clipboard.writeText failed (${e?.name}: ${e?.message}) — falling back to execCommand`,
      );
    }
  }

  return execCopy(text);
}

// Advisory only — never load-bearing. `document.featurePolicy` is a
// non-standard Chrome surface, so every uncertain answer means "try the
// modern API anyway"; all it buys is skipping one guaranteed-rejected
// promise on the first yank in a blocked frame, before the memo above takes
// over. It also sidesteps the question of whether a rejected writeText
// spends the user gesture the fallback needs.
function policyMayAllowAsync(): boolean {
  try {
    const fp = (
      document as unknown as {
        featurePolicy?: {
          allowsFeature(f: string): boolean;
          features?(): string[];
        };
      }
    ).featurePolicy;
    if (!fp || typeof fp.allowsFeature !== "function") return true;
    // A build that doesn't model the feature can't answer for it.
    if (typeof fp.features === "function") {
      const known = fp.features();
      if (Array.isArray(known) && !known.includes("clipboard-write")) {
        return true;
      }
    }
    return fp.allowsFeature("clipboard-write");
  } catch {
    return true;
  }
}

// Synchronous copy through a throwaway <textarea>.
//
// Caret mode never builds a native DOM Selection — the visual selection is
// drawn as absolutely-positioned overlay divs and the Ranges it creates are
// only ever measured with getClientRects() — so there is nothing for a bare
// execCommand to copy. Hence the textarea, which also keeps the copied text
// byte-identical to what selectionText() assembled rather than whatever the
// DOM would have serialised.
function execCopy(text: string): boolean {
  // Whatever had focus must get it back: the vim key handler bails out of
  // the entire keydown while a textarea, input or contenteditable is
  // focused, so leaking focus here would silently kill every keybinding —
  // a far worse bug than the one this fixes.
  const prev = document.activeElement as HTMLElement | null;

  // The text layer is selectable, so the user may have a mouse-dragged
  // selection live when they press y. textarea.select() would eat it.
  const sel = window.getSelection();
  const saved = sel
    ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i))
    : [];

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.tabIndex = -1;
  // An unrendered textarea can't be selected, so display:none and
  // visibility:hidden are both out. position:fixed in the viewport corner
  // keeps it out of flow instead, so neither appending it nor selecting it
  // can scroll the page out from under the caret. white-space:pre matters
  // at a 1px content box: the UA default wraps, which would lay out one
  // line box per character of a page-sized yank for a textarea nobody can
  // see. It changes nothing about what gets copied — the clipboard takes
  // the element's value, not its layout.
  ta.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;white-space:pre;";
  document.body.appendChild(ta);

  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ok = document.execCommand("copy");
  } catch (err) {
    console.warn("VimDF: execCommand copy failed:", err);
  } finally {
    ta.remove();
    if (sel) {
      sel.removeAllRanges();
      for (const r of saved) sel.addRange(r);
    }
    prev?.focus?.({ preventScroll: true });
  }
  return ok;
}
