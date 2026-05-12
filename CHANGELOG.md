# Changelog

All notable changes to VimDF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-05-03

### Fixed
- **Embedded images stopped rendering on many PDFs**: page backgrounds and vector boxes drew fine but raster figures (JBIG2 / JPEG2000 / OpenJPEG) came up blank, with `Warning: Dependent image isn't ready yet` flooding the console. Root cause: PDF.js 4.x compiles its image decoders as WebAssembly modules, and MV3's default CSP (`script-src 'self'`) blocks WASM compilation in extension pages. Added `'wasm-unsafe-eval'` to `content_security_policy.extension_pages` — the MV3-sanctioned keyword that allows WASM but not `eval()`, so the Web Store policy stays clean

## [0.3.1] - 2026-05-03

### Fixed
- **Notion (and other multi-param signed URLs) failed with HTTP 400**: clicking a PDF attachment in a Notion page surfaced `UnexpectedResponseException: Unexpected server response (400)`. The DNR redirect builds `viewer.html?file=<original-url>` by splicing the matched URL in verbatim (no percent-encoding), and the viewer was reading that back with `URLSearchParams.get("file")` — which silently truncates at the first `&` inside the URL. Notion's signed URL carries `?table=…&id=…&spaceId=…&userId=…&cache=v2` and 400s when those are missing. The viewer now grabs the raw tail of `location.search` after `?file=` so the full URL reaches PDF.js intact. Same fix unblocks any other signed URL that uses multiple query params (Drive previews, S3 with extra params, etc.)
- **Cookie-authenticated PDF fetches**: `withCredentials` was hard-coded `false`, so `getDocument` made anonymous cross-origin requests and any URL behind a session check (Notion attachments, Drive previews) failed. Now `true`, so cookies for the destination domain ride along on the fetch. Anonymous PDFs are unaffected — `withCredentials` only controls whether credentials are sent, not whether they're required

## [0.3.0] - 2026-05-03

### Added
- **Vimium-compatible tab navigation**: Vimium can't bind keys on Chrome's PDF viewer, so Vimium users had to drop back to `Ctrl+Tab` for tab moves while reading a PDF. VimDF now covers that gap with Vimium's tab keys (Web Store review feedback)
  - `J` / `K` — previous / next tab
  - `g0` / `g$` — first / last tab
  - `t` — new tab
  - `x` — close current tab
  - Intentionally **not** bound: `gt` / `gT` (would conflict with `T` for the fuzzy finder); `^`, `X`, `yt`, `<a-p>`, `W` (low-frequency or require extra permissions like `sessions`)

### Changed
- **Permissions**: Added `tabs` to `manifest.json` (required for `chrome.tabs.*` from the service worker)

## [0.2.0] - 2026-04-19

### Added
- **Download** (`Ctrl-S` / `Cmd-S`): Finder-styled save dialog to download the current PDF
  - Defaults to `~/Downloads/`; remembers the last subfolder you typed and pre-fills it next time
  - Type `papers/foo.pdf` to save under `~/Downloads/papers/` (missing subfolders are created)
  - `Ctrl-↵` / `Cmd-↵` opens Chrome's native "Save as…" picker for saving anywhere on disk
  - `Esc` cancels; click outside the dialog also cancels
- **Print** (`Ctrl-P` / `Cmd-P`): Native browser print with per-page size matching the PDF
  - Rasterises each page at 150 DPI into a hidden container; `@page` size is set from the PDF's own dimensions so there's no extra bottom margin vs. Chrome's built-in viewer
- **Scrollable & searchable help** (`?`): The keybinding reference is now a first-class Vim buffer
  - `j` / `k` scroll, `Ctrl-d` / `Ctrl-u` half-page, `Ctrl-f` / `Ctrl-b` full-page, `gg` / `G` top/bottom
  - `/` filters bindings live; `Esc` exits filter (or closes help)
- **Line-based fuzzy matching in finder** (`T`): Text hits are collected per-line (Telescope `live_grep` style) so match counts and ranking are much closer to `/` search
  - Per-page / total caps (25 / 400) keep large documents responsive
- **Jump list clarifications**: `Ctrl-O` / `Ctrl-I` / `Tab` traverse jump history after link follows, mark jumps, and outline jumps (documented in README & `?`)
- **Update notification toast**: After an extension update, the first PDF you open shows a bottom-right toast with the new version and a "What's New" button that opens the GitHub releases page. Auto-dismisses after 10s.
- **Finder jump precision + flash highlight (all entry kinds)**: Selecting any finder result (text hit, figure/table caption, section) now scrolls the hit line to the *vertical center* of the viewport and briefly flashes a yellow highlight on it, so the match is the most prominent thing on screen with equal context above and below. Per-line PDF-space geometry is captured during indexing for text/captions; sections use the XYZ/FitH coordinates already encoded in the outline destination.
- **Outline sidebar jumps flash too**: clicking an outline row in the `o` sidebar (or pressing Enter on a focused row) now scrolls-and-flashes the heading the same way the finder does, so sidebar nav and finder nav give identical visual feedback.

### Fixed
- **Marks survive zoom changes**: `ma` used to store the container's raw `scrollTop` / `scrollLeft`, so any zoom between set and `'a` landed you far from the original position (the scroll region rescales but the stored offset doesn't). Marks now anchor to a zoom-stable PDF-space point (page + `xPdf` / `yPdf`) captured via `viewport.convertToPdfPoint`, and `'a` converts back to pixels at the current zoom. Pre-existing marks keep working via a legacy scrollTop fallback; re-set them (`ma` again) to migrate.
- **`i` no longer yanks the viewport to a stale jump destination**: entering caret mode seeded from `lastJumpDest` unconditionally, so if you jumped (link / outline / finder) and then scrolled away, pressing `i` would snap the viewport back to the old target. Caret-mode now only adopts the jump dest when its landing point is still visible in the current viewport, and drops it otherwise.
- **Insert-mode focus passthrough**: `Ctrl-S` while in caret/insert mode no longer swallowed the save-dialog input's keystrokes
  - Root cause: the capture-phase `keydown` dispatcher in `vim-controller.ts` was intercepting `v` (for VISUAL mode) even when the dialog's `<input>` had focus, breaking `Cmd+V` paste
  - Fix: added a top-of-handler bail-out for `<input>`, `<textarea>`, and `contenteditable` targets so browser defaults always win inside form fields
- **Print bottom margin drift**: Print output matched Letter/A4 regardless of PDF size, leaving a tall blank strip on non-standard aspect ratios
  - Fix: `@page { size: <W>pt <H>pt; margin: 0 }` derived from the first page's viewport, and per-page wrapper boxes sized in pt

### Changed
- **README**: Added screenshots for fuzzy finder, link hints, and save dialog; documented download / print / searchable help; removed stale mention of Ctrl-F native find
- **Permissions**: Added `downloads` to `manifest.json` (required for `chrome.downloads.download`)

## [0.1.0] - 2026-04-18

### Added
- **Initial public release of VimDF** — Vim keybindings for PDF viewing in Chrome, built on PDF.js

#### Navigation
- Basic motions: `j` / `k` / `h` / `l`
- Page scrolling: `Ctrl-d` / `Ctrl-u` (half page), `Ctrl-f` / `Ctrl-b` (full page)
- Jumps: `gg` / `G` / `{n}G` for first / last / nth page
- Zoom: `+` / `=` / `-`, `0` to fit width

#### Search
- `/` to query, `n` / `N` to cycle matches (uses PDF.js `find` controller)

#### Marks & jumps
- `m{a-z}` to set a mark, `'{a-z}` to jump to it (persisted per document)
- `Ctrl-O` / `Ctrl-I` / `Tab` traverse jump history

#### Link hints
- `f` shows two-letter hint labels over every link in view; `F` opens in a new tab
- Customisable hint characters and colors

#### Outline sidebar (`o`)
- Table of contents with auto-focus on the section you're reading
- `j` / `k` to move selection, `Enter` to jump, `Esc` / `Ctrl-h` to release focus

#### Fuzzy finder (`T`)
- Telescope-style picker across outline, figure/table captions, marks, highlights, and full text
- Live preview with page thumbnail and highlighted snippet
- `Ctrl-j` / `Ctrl-k` to cycle, `Ctrl-d` / `Ctrl-u` to jump 8 rows, `Enter` to open

#### Caret mode (`i`)
- Modal caret over the text layer with full Vim motions:
  - `h` / `l` / `w` / `b` / `e` for char / word motion
  - `j` / `k` column-aware line motion; `Ctrl-h` / `Ctrl-l` for column jumps
  - `0` / `$` line ends; `zz` / `zt` / `zb` to recenter caret
- Visual modes: `v` (char), `V` (line), `Ctrl-V` (block)
- `y` to yank selection to clipboard; `H` to save selection as persistent highlight
- Right-click to remove a highlight

#### Viewer integration
- Replaces Chrome's built-in PDF viewer for `http(s)`, extension pages, and `file://` (with file access allowed)
- Publisher shims: auto-redirects Science / OpenReview / ACM / arXiv viewer pages to the raw PDF
- Remembers last page per document (toggleable)
- Theming: Auto / Dark / Light; customisable hint & status-bar colors
- Keymap aliases for half / full-page scroll commands
- Settings sync across Chrome profiles via `chrome.storage.sync`
