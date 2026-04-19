// Service worker for VimDF.
//
// Registers dynamic declarativeNetRequest rules that redirect PDF requests
// to our viewer. We use dynamic rules (not a static rule_resources file)
// because the redirect target must include the extension ID, which is only
// known at install time.

// PDF URL patterns we redirect to the viewer.
//
// Each rule is (regexFilter, fileRef). The filter picks what to match; the
// fileRef is what we pass as the `file=` parameter to our viewer, using
// declarativeNetRequest backrefs (`\0`, `\1`, ...) against the filter.
//
// For publishers whose "nice" viewer URL and the raw PDF differ only by a
// path segment (e.g. Science's /doi/epdf/ wrapper vs /doi/pdf/), we match
// both and rewrite on the fly so clicking from the HTML landing page still
// lands on a real PDF.
const REDIRECT_RULES: ReadonlyArray<{
  regexFilter: string;
  fileRef: string;
}> = [
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
  // Local files.
  { regexFilter: "^file://.*\\.pdf$", fileRef: "\\0" },
];

async function ensureRedirectRules(): Promise<void> {
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = REDIRECT_RULES.map((rule, idx) => ({
    id: idx + 1,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: {
        regexSubstitution: `${viewerUrl}?file=${rule.fileRef}`,
      },
    },
    condition: {
      regexFilter: rule.regexFilter,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
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

export {};
