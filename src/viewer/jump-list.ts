/**
 * Browser-history style jump list for in-document navigation.
 *
 * A jump is any action that noticeably changes the reader's position
 * (following a section link, clicking the outline, pressing `G`, etc.).
 * Ctrl-O walks back through past positions; Ctrl-I walks forward.
 */

export interface JumpPos {
  page: number;
  scrollTop: number;
  scrollLeft: number;
}

const LIMIT = 100;

export class JumpList {
  private back: JumpPos[] = [];
  private forward: JumpPos[] = [];

  /**
   * Record a "before" position just prior to a new jump. Clears the forward
   * stack, matching browser-history semantics.
   */
  record(from: JumpPos): void {
    this.back.push(from);
    if (this.back.length > LIMIT) this.back.shift();
    this.forward.length = 0;
  }

  popBack(current: JumpPos): JumpPos | null {
    const prev = this.back.pop();
    if (!prev) return null;
    this.forward.push(current);
    return prev;
  }

  popForward(current: JumpPos): JumpPos | null {
    const next = this.forward.pop();
    if (!next) return null;
    this.back.push(current);
    return next;
  }

  hasBack(): boolean {
    return this.back.length > 0;
  }

  hasForward(): boolean {
    return this.forward.length > 0;
  }
}
