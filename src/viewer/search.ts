import type { Viewer } from "./viewer";

/**
 * Vim-flavored search wrapper around PDF.js's PDFFindController.
 *
 * Behavior:
 *  - Smart case by default: all-lowercase query is case-insensitive, any
 *    uppercase letter makes it case-sensitive.
 *  - \c / \C override smart case (force insensitive / sensitive).
 *  - Live incremental search while typing (like Vim's 'incsearch').
 *  - n / N navigate matches after committing with Enter.
 */
export class SearchController {
  private lastQuery = "";
  private lastCaseSensitive = false;

  constructor(private viewer: Viewer) {}

  begin(): void {
    // Nothing to do yet; typing triggers queryChanged.
  }

  /**
   * Clear matches and drop query state. Dispatches findbarclose which is the
   * event PDFFindController internally resets on.
   */
  clear(): void {
    this.lastQuery = "";
    this.viewer.eventBus.dispatch("findbarclose", { source: this });
  }

  /**
   * Called on each input change for incremental search.
   */
  queryChanged(raw: string): void {
    const { query, caseSensitive } = this.parse(raw);
    this.lastQuery = query;
    this.lastCaseSensitive = caseSensitive;
    this.dispatchFind(query, {
      highlightAll: true,
      findPrevious: false,
      caseSensitive,
    });
  }

  commit(): void {
    // Re-run to move selection onto the currently-matched span (PDF.js
    // keeps the match highlighted after an incremental find).
    if (!this.lastQuery) return;
    this.dispatchFind(this.lastQuery, {
      type: "again",
      highlightAll: true,
      findPrevious: false,
      caseSensitive: this.lastCaseSensitive,
    });
  }

  next(): void {
    if (!this.lastQuery) return;
    this.dispatchFind(this.lastQuery, {
      type: "again",
      highlightAll: true,
      findPrevious: false,
      caseSensitive: this.lastCaseSensitive,
    });
  }

  prev(): void {
    if (!this.lastQuery) return;
    this.dispatchFind(this.lastQuery, {
      type: "again",
      highlightAll: true,
      findPrevious: true,
      caseSensitive: this.lastCaseSensitive,
    });
  }

  private parse(raw: string): { query: string; caseSensitive: boolean } {
    let query = raw;
    let forced: boolean | null = null;
    if (query.endsWith("\\c")) {
      forced = false;
      query = query.slice(0, -2);
    } else if (query.endsWith("\\C")) {
      forced = true;
      query = query.slice(0, -2);
    }
    const caseSensitive =
      forced !== null ? forced : /[A-Z]/.test(query); // smart case
    return { query, caseSensitive };
  }

  private dispatchFind(
    query: string,
    opts: {
      type?: string;
      highlightAll: boolean;
      findPrevious: boolean;
      caseSensitive?: boolean;
    },
  ): void {
    this.viewer.eventBus.dispatch("find", {
      source: this,
      type: opts.type ?? "",
      query,
      caseSensitive: opts.caseSensitive ?? false,
      entireWord: false,
      highlightAll: opts.highlightAll,
      findPrevious: opts.findPrevious,
      matchDiacritics: false,
    });
  }
}
