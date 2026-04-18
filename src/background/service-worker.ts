// Service worker for VimDF.
//
// Registers dynamic declarativeNetRequest rules that redirect PDF requests
// to our viewer. We use dynamic rules (not a static rule_resources file)
// because the redirect target must include the extension ID, which is only
// known at install time.

// PDF URL patterns we redirect to the viewer. We match both explicit .pdf
// extensions and well-known hosts that serve PDFs without an extension
// (e.g. arXiv).
const REDIRECT_PATTERNS: readonly string[] = [
  "^https?://.*\\.pdf(\\?.*)?$",
  "^https?://arxiv\\.org/pdf/[^?#]+(\\?.*)?$",
  "^https?://.*openreview\\.net/pdf\\?.*$",
  "^file://.*\\.pdf$",
];

async function ensureRedirectRules(): Promise<void> {
  const viewerUrl = chrome.runtime.getURL("src/viewer/viewer.html");
  const substitution = `${viewerUrl}?file=\\0`;

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = REDIRECT_PATTERNS.map((regexFilter, idx) => ({
    id: idx + 1,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { regexSubstitution: substitution },
    },
    condition: {
      regexFilter,
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
  }
});
chrome.runtime.onStartup.addListener(() => {
  void ensureRedirectRules();
});

export {};
