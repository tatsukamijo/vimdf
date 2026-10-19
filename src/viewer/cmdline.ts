/**
 * Vim-style `:` command line in the status area.
 *
 * Owns only the input: opening, editing, history and handing the typed text
 * to `onSubmit`. What a command means is up to the caller.
 */

const HISTORY_MAX = 50;

export class CommandLine {
  private bar = document.getElementById("cmdline") as HTMLDivElement;
  private input = document.getElementById("cmdInput") as HTMLInputElement;
  // Session-only, newest last — like Vim's, minus viminfo.
  private history: string[] = [];
  // Index into history while browsing with Up/Down; history.length = the
  // line being typed, whose text is kept in `draft`.
  private cursor = 0;
  private draft = "";

  constructor(
    private onSubmit: (cmd: string) => void,
    private onClose: () => void,
  ) {
    this.input.addEventListener("keydown", this.onKeyDown);
    // Clicking away abandons the line, as Esc would. Not when the whole
    // window loses focus (Cmd-Tab): Chrome refocuses the input on return.
    this.input.addEventListener("blur", () => {
      if (this.isOpen && document.hasFocus()) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  open(): void {
    this.bar.hidden = false;
    this.input.value = "";
    this.cursor = this.history.length;
    this.draft = "";
    this.input.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.bar.hidden = true;
    this.onClose();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Enter / Esc that commit or cancel an IME composition belong to the IME.
    if (e.isComposing || e.keyCode === 229) return;
    // No completion yet; without this Tab moves focus away and the blur
    // throws the line away.
    if (e.key === "Tab") {
      e.preventDefault();
      return;
    }
    const ctrlBracket = e.ctrlKey && e.key === "[";
    if (e.key === "Escape" || ctrlBracket) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // NFKC folds full-width input (`：ｑ`, `１２`) to ASCII; extra leading
      // colons are ignored, as in Vim (`::q`).
      const cmd = this.input.value.normalize("NFKC").replace(/^[:\s]+/, "").trim();
      if (cmd) {
        if (this.history[this.history.length - 1] !== cmd) this.history.push(cmd);
        if (this.history.length > HISTORY_MAX) this.history.shift();
      }
      this.close();
      if (cmd) this.onSubmit(cmd);
      return;
    }
    // Backspace on an empty line leaves command-line mode, as in Vim.
    if (e.key === "Backspace" && this.input.value === "") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      this.browse(e.key === "ArrowUp" ? -1 : 1);
    }
  };

  private browse(dir: -1 | 1): void {
    const next = this.cursor + dir;
    if (next < 0 || next > this.history.length) return;
    if (this.cursor === this.history.length) this.draft = this.input.value;
    this.cursor = next;
    this.input.value =
      next === this.history.length ? this.draft : this.history[next];
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }
}
