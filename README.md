# VimDF

A Chrome extension that turns PDF viewing into a Vim-keyboard experience. Scroll, jump, search, outline-navigate, select and highlight — all without leaving the home row.

## Features

- **Vim-style navigation** — `j`/`k`/`h`/`l`, `gg`/`G`/`{n}G`, `Ctrl-d`/`Ctrl-u`/`Ctrl-f`/`Ctrl-b`
- **Search** — `/` to query, `n`/`N` to cycle matches; `Ctrl-F` for PDF.js native find
- **Marks** — `m{a-z}` to set, `'{a-z}` to jump back
- **Link hints** — `f` to show yellow hint labels on every link in view, `F` for new tab
- **Jump list** — `Ctrl-O` / `Ctrl-I` / `Tab` to traverse your jump history (like Vim's `''` stack)
- **Outline sidebar** — `o` toggles table of contents, auto-focuses the section you're currently reading; `j`/`k` moves selection, `Enter` jumps
- **Caret mode** — `i` enters a Vim-modal caret over the text layer:
  - `h`/`l`/`w`/`b`/`e` for char/word motion
  - `j`/`k` column-aware line motion, `Ctrl-h`/`Ctrl-l` for column jumps
  - `0`/`$` line ends, `zz`/`zt`/`zb` caret-recentering
  - `v` / `V` / `Ctrl-V` for char / line / block VISUAL modes
  - `y` yank to clipboard, `H` save selection as persistent highlight
- **Remembers last page** per document (toggleable)
- **Theming** — Auto/Dark/Light; customizable hint & status-bar colors
- **Keymap aliases** — bind your own keys to half/full-page scroll commands

Press `?` inside the viewer for the full keybinding reference.

## Install

### From source (developer mode)

```bash
git clone https://github.com/tatsukamijo/vimdf.git
cd vimdf
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `dist/` folder
4. To open `file://` PDFs directly, click **Details** → toggle **Allow access to file URLs**

### From the Chrome Web Store

*Coming soon.*

## Usage

Once installed, any `.pdf` URL you navigate to — over `http(s)`, extension pages, or `file://` (with file access allowed) — is automatically handled by VimDF. Press `?` to see all keybindings.

Settings live in the extension's Options page (right-click the toolbar icon → Options). Theme, scroll steps, zoom step, page-scroll aliases, link-hint colors, status-bar colors, and per-document last-page persistence are all configurable and sync across Chrome profiles.

## Development

```bash
npm run dev        # Vite dev server with HMR
npm run build      # production bundle in dist/
npm run typecheck  # tsc --noEmit
```

The codebase is roughly:

```
src/
├── background/service-worker.ts   # DNR rule to intercept PDF navigations
├── common/settings.ts             # chrome.storage.sync schema + migrations
├── options/                       # options page (HTML/CSS/TS)
└── viewer/                        # the viewer itself
    ├── viewer.ts                  # PDF.js integration, state persistence
    ├── vim-controller.ts          # root keydown dispatcher
    ├── caret-mode.ts              # modal text-caret navigation & selection
    ├── hints.ts                   # link-hint overlay
    ├── outline.ts                 # sidebar TOC
    ├── search.ts                  # / and Ctrl-F search controllers
    ├── marks.ts                   # per-doc mark persistence
    ├── highlights.ts              # user-saved highlights layer
    └── continuous-scroll.ts       # rAF-driven smooth scroll for held keys
```

## Tech

- [PDF.js](https://github.com/mozilla/pdf.js) for rendering
- [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin/) for MV3 bundling
- TypeScript, Vite, Chrome Extension Manifest V3

## Author

Tatsuya Kamijo — <tatsukamijo@icloud.com>

## License

MIT
