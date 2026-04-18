import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";

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
}

let outlineRows: RowMeta[] = [];

export async function buildOutline(
  doc: PDFDocumentProxy,
  linkService: PDFLinkService,
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

  tree.appendChild(renderList(outline, linkService));
  void resolveOutlinePages(doc);
}

async function resolveOutlinePages(doc: PDFDocumentProxy): Promise<void> {
  for (const meta of outlineRows) {
    meta.page = await resolveDestPage(doc, meta.node.dest);
  }
}

async function resolveDestPage(
  doc: PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  if (!dest) return null;
  let arr: unknown = dest;
  if (typeof dest === "string") {
    try {
      arr = await doc.getDestination(dest);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const ref = arr[0];
  if (!ref) return null;
  try {
    const idx = await doc.getPageIndex(
      ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0],
    );
    return idx + 1;
  } catch {
    return null;
  }
}

function renderList(
  nodes: OutlineNode[],
  linkService: PDFLinkService,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const row = document.createElement("div");
    row.className = "outline-item";
    row.textContent = node.title;
    const activate = (): void => {
      if (node.dest) {
        linkService.goToDestination(
          node.dest as Parameters<PDFLinkService["goToDestination"]>[0],
        );
      } else if (node.url) {
        window.open(node.url, "_blank", "noopener");
      }
    };
    activatorByRow.set(row, activate);
    row.addEventListener("click", activate);
    outlineRows.push({ row, node, page: null });
    frag.appendChild(row);
    if (node.items && node.items.length > 0) {
      const children = document.createElement("div");
      children.className = "outline-children";
      children.appendChild(renderList(node.items, linkService));
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
