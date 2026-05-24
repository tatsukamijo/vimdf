// Pulls focus onto the VimDF viewer iframe when it's embedded in a host
// page (e.g. a LaTeX live-preview wrapper around `<iframe src="paper.pdf">`).
//
// The viewer.html loaded inside the iframe attaches its keydown handler to
// its own document, but a cross-origin iframe can't transfer focus to
// itself — the inner window can `.focus()` its own elements all day, but
// the iframe element in the parent still doesn't receive focus, so the
// user's keys go to the parent's body (= browser scroll) until they click
// the PDF. The parent CAN focus its child iframe regardless of origin, so
// this script runs in every page, listens for a `vimdf:loaded` postMessage
// from the viewer, finds which iframe sent it, and focuses that element.
//
// Top-level PDF tabs (no parent frame) don't need this — the tab itself
// has natural focus.

window.addEventListener("message", (event) => {
  if (!event.origin.startsWith("chrome-extension://")) return;
  if (event.data !== "vimdf:loaded") return;
  for (const iframe of document.querySelectorAll("iframe")) {
    if (iframe.contentWindow === event.source) {
      iframe.focus();
      return;
    }
  }
});

export {};
