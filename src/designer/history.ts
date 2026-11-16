/**
 * Undo/redo of snapshots. A change recorded with a `key` (e.g. the parameter
 * a slider edits) replaces the previous entry while that entry is still open
 * for the same key, so a whole slider drag becomes one undo step. `seal()`
 * closes the open entry (on pointer-up / the final change event).
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private openKey: string | null = null;

  constructor(
    private present: T,
    private readonly limit = 200,
  ) {}

  get current(): T {
    return this.present;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  /** Record a new state. Returns false when it is merged into the open entry. */
  record(next: T, key: string | null = null): boolean {
    this.future = [];
    if (key !== null && key === this.openKey) {
      this.present = next;
      return false;
    }
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = next;
    this.openKey = key;
    return true;
  }

  /** Close the open entry: the next change starts a new undo step. */
  seal() {
    this.openKey = null;
  }

  /** Replace the present without an undo step (e.g. loading a tool). */
  reset(state: T) {
    this.past = [];
    this.future = [];
    this.present = state;
    this.openKey = null;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    this.openKey = null;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    this.openKey = null;
    return next;
  }
}
