export interface MarkPosition {
  page: number;
  scrollTop: number;
  scrollLeft: number;
}

type MarkMap = Record<string, MarkPosition>;

export class MarksStore {
  private marks: MarkMap = {};

  constructor(private pdfUrl: string) {}

  private get key(): string {
    return `vimdf:marks:${this.pdfUrl}`;
  }

  async load(): Promise<void> {
    const result = await chrome.storage.local.get(this.key);
    this.marks = (result[this.key] as MarkMap | undefined) ?? {};
  }

  set(name: string, pos: MarkPosition): void {
    this.marks[name] = pos;
    void chrome.storage.local.set({ [this.key]: this.marks });
  }

  get(name: string): MarkPosition | undefined {
    return this.marks[name];
  }

  all(): Readonly<MarkMap> {
    return this.marks;
  }
}
