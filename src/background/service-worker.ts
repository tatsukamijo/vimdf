// Service worker for VimDF.
//
// Registers dynamic declarativeNetRequest rules that redirect PDF requests
// to our viewer. We use dynamic rules (not a static rule_resources file)
// because the redirect target must include the extension ID, which is only
// known at install time.

// A `responseHeaders` rule condition (Chrome 128+). Not in @types/chrome
// 0.0.270 yet, so we model the slice of HeaderInfo we actually use.
interface ResponseHeaderMatch {
  header: string;
  values?: string[];
}

// PDF patterns we redirect to the viewer.
//
// Each rule is (regexFilter, fileRef[, responseHeaders]). The filter picks
// what to match; the fileRef is what we pass as the `file=` parameter to our
// viewer, using declarativeNetRequest backrefs (`\0`, `\1`, ...) against the
// filter. A rule that also sets `responseHeaders` only fires when the
// response carries a matching header — used to catch PDFs by Content-Type.
//
// For publishers whose "nice" viewer URL and the raw PDF differ only by a
// path segment (e.g. Science's /doi/epdf/ wrapper vs /doi/pdf/), we match
// both and rewrite on the fly so clicking from the HTML landing page still
// lands on a real PDF.
const REDIRECT_RULES: ReadonlyArray<{
  regexFilter: string;
  fileRef: string;
  priority?: number;
  responseHeaders?: ResponseHeaderMatch[];
  excludedResponseHeaders?: ResponseHeaderMatch[];
}> = [
  // GitHub: a `/blob/` URL ending in .pdf is GitHub's HTML viewer page, not
  // the PDF bytes (it answers `Content-Type: text/html`). Feeding that to the
  // viewer yields "invalid PDF structure". Rewrite to the raw host, which
  // serves the actual file. Same shape as the Science rule: nice URL vs raw
  // PDF differ by a path segment. Needs a higher priority than the generic
  // `.pdf` rule below, which also matches a blob URL's `.pdf` suffix.
  {
    regexFilter:
      "^https?://github\\.com/([^/]+/[^/]+)/blob/(.+?\\.pdf)(\\?.*)?$",
    fileRef: "https://raw.githubusercontent.com/\\1/\\2",
    priority: 2,
  },
  // Any URL ending in .pdf (covers nature.com/articles/*.pdf, direct links).
  { regexFilter: "^https?://.*\\.pdf(\\?.*)?$", fileRef: "\\0" },
  // arXiv serves PDFs without a .pdf extension.
  {
    regexFilter: "^https?://arxiv\\.org/pdf/[^?#]+(\\?.*)?$",
    fileRef: "\\0",
  },
  // OpenReview.
  {
    regexFilter: "^https?://.*openreview\\.net/pdf\\?.*$",
    fileRef: "\\0",
  },
  // Science (science.org): /doi/pdf/... is the raw PDF; /doi/epdf/ and
  // /doi/reader/ are HTML wrappers around their in-house viewer. Normalize
  // any of the three to /doi/pdf/ so we always intercept the click before
  // their JS has a chance to swap in its own reader UI.
  {
    regexFilter:
      "^(https?://(?:www\\.)?science\\.org/doi/)(?:reader|e?pdf)(/.+)$",
    fileRef: "\\1pdf\\2",
  },
  // ACM Digital Library.
  {
    regexFilter: "^https?://dl\\.acm\\.org/doi/pdf/.+$",
    fileRef: "\\0",
  },
  // Catch-all by Content-Type. The rules above only match URLs that *look*
  // like PDFs (a `.pdf` suffix, or a known publisher path); this one matches
  // any top-level navigation the server answers with `Content-Type:
  // application/pdf`, whatever the URL looks like. That covers PDFs served at
  // extensionless routes — local dev servers (VS Code Live Server, `python
  // -m http.server`), object-store keys, API endpoints that stream a PDF.
  //
  // `responseHeaders` conditions match at the onHeadersReceived stage
  // (Chrome 128+), so the request reaches the server once before the
  // redirect fires — one extra fetch versus the URL rules above, which is
  // why those stay first as the fast path for the common `.pdf` case.
  {
    regexFilter: "^https?://.+",
    fileRef: "\\0",
    responseHeaders: [
      {
        header: "content-type",
        values: ["application/pdf*", "application/x-pdf*"],
      },
    ],
    // Skip when the server says "this is a download, not something to
    // render." Many such endpoints are one-shot download CGIs / signed-
    // once URLs that 4xx if refetched — and DNR's responseHeaders match
    // fires *after* the original response, so the viewer's subsequent
    // getDocument() is a fresh request the server rejects. Letting the
    // browser handle it natively downloads the PDF as intended.
    excludedResponseHeaders: [
      { header: "content-disposition", values: ["attachment*"] },
    ],
  },
  // Local files.
  { regexFilter: "^file://.*\\.pdf$", fileRef: "\\0" },
];

async function ensureRedirectRules(): Promise<void> {
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const toDnrRules = (
    rules: ReadonlyArray<(typeof REDIRECT_RULES)[number]>,
  ): chrome.declarativeNetRequest.Rule[] =>
    rules.map((rule, idx) => {
      const condition: chrome.declarativeNetRequest.RuleCondition = {
        regexFilter: rule.regexFilter,
        // MAIN_FRAME: a PDF opened as its own tab. SUB_FRAME: a PDF embedded
        // in an <iframe> — e.g. a LaTeX live-preview server whose page is a
        // thin HTML shell around `<iframe src="paper.pdf">`. Without
        // SUB_FRAME those never reach VimDF: the rule only ever saw the
        // (HTML) main frame, so the iframe kept Chrome's built-in viewer.
        resourceTypes: [
          chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          chrome.declarativeNetRequest.ResourceType.SUB_FRAME,
        ],
      };
      if (rule.responseHeaders || rule.excludedResponseHeaders) {
        // Neither `responseHeaders` nor `excludedResponseHeaders` is in
        // @types/chrome 0.0.270 yet — attach via cast so the runtime
        // still receives the condition.
        const headerCond = condition as {
          responseHeaders?: ResponseHeaderMatch[];
          excludedResponseHeaders?: ResponseHeaderMatch[];
        };
        if (rule.responseHeaders) {
          headerCond.responseHeaders = rule.responseHeaders;
        }
        if (rule.excludedResponseHeaders) {
          headerCond.excludedResponseHeaders = rule.excludedResponseHeaders;
        }
      }
      return {
        id: idx + 1,
        priority: rule.priority ?? 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: {
            regexSubstitution: `${viewerUrl}?file=${rule.fileRef}`,
          },
        },
        condition,
      };
    });

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: toDnrRules(REDIRECT_RULES),
    });
  } catch (err) {
    // A `responseHeaders` condition needs Chrome 128+. On older Chrome the
    // whole batch is rejected (updateDynamicRules is atomic and leaves the
    // rule set untouched on failure), so retry with just the URL-pattern
    // rules — core `.pdf` interception keeps working.
    console.warn(
      "VimDF: rule set with responseHeaders rejected; " +
        "retrying with URL-only rules:",
      err,
    );
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: toDnrRules(REDIRECT_RULES.filter((r) => !r.responseHeaders)),
    });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void ensureRedirectRules();
  if (details.reason === "install") {
    void chrome.storage.local.set({ vimdf_show_conflict_warning: true });
  } else if (details.reason === "update") {
    void chrome.storage.local.set({
      vimdf_show_update_notification: true,
      vimdf_version: chrome.runtime.getManifest().version,
      vimdf_previous_version: details.previousVersion ?? "",
    });
  }
});
chrome.runtime.onStartup.addListener(() => {
  void ensureRedirectRules();
});

// Vimium-compatible tab commands. Vimium itself can't bind keys on Chrome's
// PDF viewer, and our content script runs there but can't call chrome.tabs.*
// directly — so the viewer sends an action here and we drive the tab API.
type TabAction =
  | "next"
  | "prev"
  | "first"
  | "last"
  | "new"
  | "close"
  | "back"
  | "forward";

async function runTabAction(action: TabAction): Promise<void> {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 0) return;
  const sorted = tabs.slice().sort((a, b) => a.index - b.index);
  const activeIdx = sorted.findIndex((t) => t.active);

  const activate = async (idx: number): Promise<void> => {
    const t = sorted[idx];
    if (t?.id != null) await chrome.tabs.update(t.id, { active: true });
  };

  switch (action) {
    case "next":
      await activate((activeIdx + 1) % sorted.length);
      return;
    case "prev":
      await activate((activeIdx - 1 + sorted.length) % sorted.length);
      return;
    case "first":
      await activate(0);
      return;
    case "last":
      await activate(sorted.length - 1);
      return;
    case "new":
      await chrome.tabs.create({});
      return;
    case "close":
      if (activeIdx >= 0 && sorted[activeIdx].id != null) {
        await chrome.tabs.remove(sorted[activeIdx].id!);
      }
      return;
    case "back":
    case "forward": {
      // chrome.tabs.goBack/goForward throws on an empty history stack; swallow
      // so VimDF stays silent at the edges instead of surfacing a runtime error.
      const id = sorted[activeIdx]?.id;
      if (id == null) return;
      try {
        if (action === "back") await chrome.tabs.goBack(id);
        else await chrome.tabs.goForward(id);
      } catch {
        // no-op: nothing to go back/forward to
      }
      return;
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && typeof msg === "object" && msg.type === "vimdf.tab") {
    void runTabAction(msg.action as TabAction);
  }
});

export {};
