/** Something that can be released. */
export interface Disposable {
  dispose(): void;
}

/** A minimal event emitter with the same shape as the editor's, so the core runs without any editor. */
export class Emitter<T = void> implements Disposable {
  private listeners = new Set<(value: T) => void>();

  /** Subscribes a listener. Dispose the result to unsubscribe. */
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Where the core keeps small pieces of state between runs, such as reviewed marks. */
export interface Memento {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): unknown;
}

/** What the core needs from the editor it runs in. */
export interface Host {
  memento: Memento;
  /** Text of a file that is open with unsaved edits, so excerpts are checked against what the reviewer sees. */
  openText?(fsPath: string): string | undefined;
}
