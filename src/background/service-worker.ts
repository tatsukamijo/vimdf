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
  // Any URL whose *path* ends in .pdf (covers nature.com/articles/*.pdf,
  // direct links). Anchored to the path — `[^?#]*` — so a `.pdf` that only
  // appears inside the query string does NOT fire this request-stage
  // redirect. Example: ScienceDirect's
  // `/pii/<id>/pdfft?md5=…&pid=…-main.pdf` answers the first navigation
  // with a Cloudflare "are you a robot?" interstitial; redirecting at the
  // request stage would hand that HTML to the viewer ("Invalid PDF
  // structure") and the user never gets to solve the challenge. Left
  // alone, the challenge renders natively, and once it's passed the server
  // answers with a real PDF — which the Content-Type catch-all below then
  // routes to the viewer. Query-only `.pdf` URLs that do serve PDF bytes
  // directly are likewise caught by that catch-all, one response later.
  { regexFilter: "^https?://[^?#]*\\.pdf([?#].*)?$", fileRef: "\\0" },
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

// ---------------------------------------------------------------------------
// One-shot interception bypass.
//
// When the viewer fetches its `file=` URL and gets something that isn't a
// PDF — a Cloudflare "are you a robot?" interstitial, a login wall, plain
// HTML at a `.pdf` path — showing "Invalid PDF structure" is a dead end:
// whatever the server wanted to show needs to render *natively* so the user
// can act on it. The viewer sends `vimdf.bypass` with the URL; we install a
// session-scoped `allow` rule for exactly that URL (outranking every
// redirect rule), reply, and the viewer re-navigates. Once the bypassed
// navigation finishes loading — or after a fallback timeout — the rule is
// dropped, so the next hit on that URL (e.g. the post-captcha reload, now
// carrying the clearance cookie) is intercepted normally again.

const BYPASS_RULE_ID = 4242;
// Ceiling on how long a bypass stays armed when we never see the bypassed
// navigation complete. Best-effort: a service-worker restart drops the
// timer. A rule that outlives both disarm paths is contained — it is
// scoped to one tab and one exact URL — and gets swept on the next
// service-worker start (below).
const BYPASS_FALLBACK_MS = 60_000;

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function removeBypassRule(): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [BYPASS_RULE_ID],
    });
  } catch {
    // Nothing to remove.
  }
}

let bypassTimer: ReturnType<typeof setTimeout> | undefined;
let bypassTabId: number | undefined;

async function addBypassRule(url: string, tabId?: number): Promise<void> {
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    regexFilter: `^${escapeRegex(url)}$`,
    // MAIN_FRAME only: the viewer never requests a bypass from inside an
    // iframe (see main() in viewer.ts), and a narrower rule can't leak
    // interception away from embedded PDFs.
    resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
  };
  // Scope the stand-down to the requesting tab (tabIds conditions are a
  // session-rule-only feature — exactly why the bypass uses session rules).
  // Other tabs opening the same URL keep normal interception, and a rule
  // that somehow outlives its disarm paths dies with the tab.
  if (tabId !== undefined) condition.tabIds = [tabId];
  await chrome.declarativeNetRequest.updateSessionRules({
    // Drop any stale bypass first — one armed bypass at a time.
    removeRuleIds: [BYPASS_RULE_ID],
    addRules: [
      {
        id: BYPASS_RULE_ID,
        // Outranks every redirect rule above (their max priority is 2).
        priority: 100,
        action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
        condition,
      },
    ],
  });
  bypassTabId = tabId;
  if (bypassTimer !== undefined) clearTimeout(bypassTimer);
  bypassTimer = setTimeout(() => void removeBypassRule(), BYPASS_FALLBACK_MS);
}

// Sweep any bypass that outlived its disarm paths (e.g. the fallback timer
// died with a service-worker shutdown). Top-level code runs on every
// service-worker start; an in-flight bypass can't be swept by accident,
// because the worker that armed it stays alive well past the sub-second
// window in which the viewer re-navigates.
void removeBypassRule();

// Disarm as soon as the bypassed tab finishes loading whatever the server
// actually serves — so a post-challenge reload of the same URL is
// intercepted again (and the viewer's fetch then succeeds, because the
// clearance cookie now exists). The timer above covers what this misses.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === bypassTabId && changeInfo.status === "complete") {
    bypassTabId = undefined;
    void removeBypassRule();
  }
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && typeof msg === "object" && msg.type === "vimdf.tab") {
    void runTabAction(msg.action as TabAction);
    return false;
  }
  if (
    msg &&
    typeof msg === "object" &&
    msg.type === "vimdf.bypass" &&
    typeof msg.url === "string"
  ) {
    addBypassRule(msg.url, sender.tab?.id).then(
      () => sendResponse(true),
      (err) => {
        console.warn("VimDF: failed to install bypass rule:", err);
        sendResponse(false);
      },
    );
    return true; // keep the channel open for the async sendResponse
  }
  return false;
});

export {};
