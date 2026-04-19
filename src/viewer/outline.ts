import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { Viewer } from "./viewer";

// Estimated heading geometry in PDF points. We don't know an outline entry's
// true text metrics (they're not indexed), but ~14pt tall × ~400pt wide covers
// most body-width headings without overflowing narrow pages.
const SECTION_HEIGHT_PDF = 14;
const SECTION_WIDTH_PDF = 400;

interface OutlineNode {
  title: string;
  dest?: unknown;
  url?: string | null;
  items: OutlineNode[];
}

const activatorByRow = new WeakMap<HTMLElement, () => void>();

interface RowMeta {
  row: HTMLElement;
  node: OutlineNode;
  page: number | null; // resolved asynchronously from node.dest
  xPdf: number | null; // resolved PDF-space X from dest (XYZ/FitR only)
  yPdf: number | null; // resolved PDF-space Y from dest (top for XYZ/FitH/FitBH)
}

let outlineRows: RowMeta[] = [];

export interface OutlineSection {
  title: string;
  row: HTMLElement;
  page: number | null;
  xPdf: number | null;
  yPdf: number | null;
  activate: () => void;
}

export function getOutlineSections(): OutlineSection[] {
  const out: OutlineSection[] = [];
  for (const meta of outlineRows) {
    const title = (meta.row.textContent ?? "").trim();
    if (!title) continue;
    const activate = activatorByRow.get(meta.row) ?? (() => meta.row.click());
    out.push({
      title,
      row: meta.row,
      page: meta.page,
      xPdf: meta.xPdf,
      yPdf: meta.yPdf,
      activate,
    });
  }
  return out;
}

export async function buildOutline(
  doc: PDFDocumentProxy,
  linkService: PDFLinkService,
  viewer: Viewer,
): Promise<void> {
  outlineRows = [];
  const tree = document.getElementById("outlineTree");
  if (!tree) return;
  tree.innerHTML = "";

  const outline = (await doc.getOutline()) as OutlineNode[] | null;
  if (!outline || outline.length === 0) {
    tree.textContent = "(no outline)";
    tree.style.color = "#888";
    tree.style.padding = "12px";
    return;
  }

  tree.appendChild(renderList(outline, linkService, viewer));
  void resolveOutlinePages(doc);
}

async function resolveOutlinePages(doc: PDFDocumentProxy): Promise<void> {
  for (const meta of outlineRows) {
    const resolved = await resolveDest(doc, meta.node.dest);
    meta.page = resolved.page;
    meta.xPdf = resolved.xPdf;
    meta.yPdf = resolved.yPdf;
  }
}

/**
 * Resolve a PDF destination (either a named string or an array) to its target
 * page and PDF-space coordinates. For XYZ dests, `xPdf`/`yPdf` give the
 * top-left of where the viewport should land; for FitH/FitBH only `yPdf` is
 * meaningful (horizontal fit). Returns nulls when the destination doesn't
 * carry explicit coordinates (Fit / FitB) or when resolution fails.
 */
async function resolveDest(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<{ page: number | null; xPdf: number | null; yPdf: number | null }> {
  const none = { page: null, xPdf: null, yPdf: null };
  if (!dest) return none;
  let arr: unknown = dest;
  if (typeof dest === "string") {
    try {
      arr = await doc.getDestination(dest);
    } catch {
      return none;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return none;
  const ref = arr[0];
  if (!ref) return none;
  let page: number | null = null;
  try {
    const idx = await doc.getPageIndex(
      ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
    );
    page = idx + 1;
  } catch {
    return none;
  }
  const name = (arr[1] as { name?: string } | undefined)?.name;
  let xPdf: number | null = null;
  let yPdf: number | null = null;
  if (name === "XYZ" || name === "FitR") {
    xPdf = typeof arr[2] === "number" ? (arr[2] as number) : null;
    yPdf = typeof arr[3] === "number" ? (arr[3] as number) : null;
  } else if (name === "FitH" || name === "FitBH") {
    yPdf = typeof arr[2] === "number" ? (arr[2] as number) : null;
  }
  return { page, xPdf, yPdf };
}

function renderList(
  nodes: OutlineNode[],
  linkService: PDFLinkService,
  viewer: Viewer,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const row = document.createElement("div");
    row.className = "outline-item";
    row.textContent = node.title;
    const meta: RowMeta = {
      row,
      node,
      page: null,
      xPdf: null,
      yPdf: null,
    };
    outlineRows.push(meta);
    // Activation reads `meta` live — `resolveOutlinePages` mutates these
    // fields asynchronously, so by the time the user actually clicks, the
    // coords are (usually) populated and we can scroll-and-flash precisely.
    // If they're still null (cold click before resolution completes, or a
    // Fit/FitB dest without coords), fall back to the link service.
    const activate = (): void => {
      if (meta.page !== null && meta.yPdf !== null) {
        viewer.flashScrollToLine(
          meta.page,
          meta.xPdf ?? 0,
          // `yPdf` from XYZ/FitH is the *top* of the destination region;
          // `flashScrollToLine` wants the baseline — shift down by the
          // estimated height so line top ≈ yPdf.
          meta.yPdf - SECTION_HEIGHT_PDF,
          SECTION_WIDTH_PDF,
          SECTION_HEIGHT_PDF,
        );
      } else if (node.dest) {
        linkService.goToDestination(
          node.dest as Parameters<PDFLinkService["goToDestination"]>[0],
        );
      } else if (node.url) {
        window.open(node.url, "_blank", "noopener");
      }
    };
    activatorByRow.set(row, activate);
    row.addEventListener("click", activate);
    frag.appendChild(row);
    if (node.items && node.items.length > 0) {
      const children = document.createElement("div");
      children.className = "outline-children";
      children.appendChild(renderList(node.items, linkService, viewer));
      frag.appendChild(children);
    }
  }
  return frag;
}

export function toggleSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  const hidden = sidebar.hasAttribute("hidden");
  if (hidden) {
    sidebar.removeAttribute("hidden");
    document.body.classList.add("sidebar-open");
  } else {
    sidebar.setAttribute("hidden", "");
    document.body.classList.remove("sidebar-open");
    clearOutlineFocus();
  }
}

export function isSidebarOpen(): boolean {
  const sidebar = document.getElementById("sidebar");
  return !!sidebar && !sidebar.hasAttribute("hidden");
}

function getItems(): HTMLElement[] {
  const tree = document.getElementById("outlineTree");
  if (!tree) return [];
  return Array.from(tree.querySelectorAll<HTMLElement>(".outline-item"));
}

let focusedIdx = -1;

export function hasOutlineItems(): boolean {
  return getItems().length > 0;
}

export function isOutlineFocusActive(): boolean {
  return focusedIdx >= 0;
}

function applyFocus(items: HTMLElement[], idx: number): void {
  items.forEach((el, i) => el.classList.toggle("outline-focused", i === idx));
  focusedIdx = idx;
  // Scroll within the sidebar only — a naive scrollIntoView can propagate to
  // other scrollable ancestors (e.g. the viewer container) under some layouts.
  const sidebar = document.getElementById("sidebar");
  const item = items[idx];
  if (sidebar) {
    const ir = item.getBoundingClientRect();
    const sr = sidebar.getBoundingClientRect();
    if (ir.top < sr.top) sidebar.scrollTop += ir.top - sr.top - 4;
    else if (ir.bottom > sr.bottom) sidebar.scrollTop += ir.bottom - sr.bottom + 4;
  }
}

export function focusFirstOutlineItem(): boolean {
  const items = getItems();
  if (items.length === 0) return false;
  applyFocus(items, 0);
  return true;
}

/**
 * Focus the outline item that best represents the current viewing position —
 * i.e. the last entry whose resolved page ≤ `currentPage`. Falls back to the
 * first item when no row's page has resolved yet.
 */
export function focusCurrentSection(currentPage: number): boolean {
  const items = getItems();
  if (items.length === 0) return false;
  let best = -1;
  for (let i = 0; i < outlineRows.length; i++) {
    const p = outlineRows[i].page;
    if (p !== null && p <= currentPage) best = i;
  }
  if (best < 0) {
    applyFocus(items, 0);
    return true;
  }
  const itemIdx = items.indexOf(outlineRows[best].row);
  applyFocus(items, itemIdx >= 0 ? itemIdx : 0);
  return true;
}

export function moveOutlineFocus(delta: number): boolean {
  const items = getItems();
  if (items.length === 0) return false;
  if (focusedIdx < 0) {
    applyFocus(items, delta > 0 ? 0 : items.length - 1);
    return true;
  }
  const next = Math.max(0, Math.min(items.length - 1, focusedIdx + delta));
  applyFocus(items, next);
  return true;
}

export function activateFocusedOutline(): boolean {
  const items = getItems();
  if (focusedIdx < 0 || focusedIdx >= items.length) return false;
  const activate = activatorByRow.get(items[focusedIdx]);
  if (!activate) return false;
  activate();
  return true;
}

export function clearOutlineFocus(): void {
  getItems().forEach((el) => el.classList.remove("outline-focused"));
  focusedIdx = -1;
}
