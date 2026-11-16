import { createHash } from 'crypto';
import { Disposable, Emitter, Host } from './events';
import { addedLines, changedFiles, gitBranch, gitHead, readTextLines } from './github';
import { Step, Story, UnstoriedFile } from './model';
import { DEFAULT_SET, Store, StorySet, setIdFor } from './store';

/** What the reviewer had read when they marked a story reviewed, kept so a later change can be shown on its own. */
interface ReviewMark {
  hash: string;
  at: string;
  steps: Record<string, { hash: string; lines: string[] }>;
}

export type ReviewStatus = 'reviewed' | 'changed' | 'new';

/** How one step compares with the files on disk, with other stories and with the last review. */
export interface StepInsight {
  /** Lines of the excerpt that no longer match the file. */
  stale: number[];
  /** Index of an earlier story that shows this exact step, or -1. */
  sameAs: number;
  /** Against the last review of a story that has changed since: null when the story has not. */
  since: 'same' | 'changed' | 'new' | null;
  /** Indexes into the step's lines that are new since the last review. */
  fresh: number[];
}

export interface StoryInsight {
  status: ReviewStatus;
  reviewedAt?: string;
  steps: StepInsight[];
}

export interface LineCoverage {
  /** Lines added or changed since the base, blank lines left out. */
  total: number;
  /** Of those, the ones a story step shows. */
  shown: number;
  /** In test files that a story names as its tests. */
  tests: number;
  /** In files the stories leave out with a reason. */
  leftOut: number;
  /** Shown nowhere. */
  unseen: number;
  /** Files that are in a story but have changed lines no step shows. */
  files: { path: string; lines: number[] }[];
}

/** Where the reviewer is: which story, step and line, and which stories are reviewed. */
export class Session implements Disposable {
  view: 'overview' | 'story' = 'overview';
  storyIndex = 0;
  stepIndex = 0;
  line = 0;
  /** HEAD has moved on from the commit the stories were written for. */
  stale = false;
  /** Files that differ from the base of the stories, or undefined when that could not be checked. */
  changed?: string[];
  /** Lines each file gained or changed since the base, or undefined when that could not be checked. */
  added?: Map<string, number[]>;
  /** The checked-out branch, once git has answered. It decides which story set is shown. */
  branch?: string;
  /** A set the reviewer picked by hand. It holds until the branch changes or the branch gets its own set. */
  private manual?: string;
  private knownSets = '';
  /** Excerpt lines that no longer match the file, keyed by story and step index. */
  private staleLines = new Map<string, number[]>();

  private readonly changeEmitter = new Emitter();
  private readonly navigateEmitter = new Emitter();
  /** Fires when anything shown in the panel or tree may have changed. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fires when the editor should follow to the current step and line. */
  readonly onDidNavigate = this.navigateEmitter.event;

  private readonly subscriptions: Disposable[];
  private readonly memento: Host['memento'];

  /**
   * The editor calls checkGit() when a file is saved, the window gains focus or the branch
   * changes, and store.reload() when .stories/ changes. The session watches nothing itself.
   */
  constructor(readonly store: Store, private readonly host: Host) {
    this.memento = host.memento;
    this.subscriptions = [
      store.onDidChange(() => {
        if (this.pickSet()) {
          return; // Switching sets reloads the store, which lands here again.
        }
        this.clamp();
        this.checkFiles();
        this.changeEmitter.fire();
        void this.checkGit();
      })
    ];
    this.pickSet();
    this.checkFiles();
    void this.checkGit();
  }

  /** Shows a set the reviewer chose, whatever the branch. */
  selectSet(setId: string): void {
    this.manual = setId;
    if (!this.pickSet()) {
      this.changeEmitter.fire();
    }
  }

  /** Set when the stories on screen were written for a different branch than the one checked out. */
  get foreign(): { branch: string; writtenFor: string } | undefined {
    const { branch, store } = this;
    if (!branch || !store.doc || store.setId === DEFAULT_SET || store.setId === setIdFor(branch) || store.doc.head === branch) {
      return undefined;
    }
    return { branch, writtenFor: store.doc.head || store.setId };
  }

  get stories(): Story[] {
    return this.store.doc?.stories ?? [];
  }
  get story(): Story | undefined {
    return this.stories[this.storyIndex];
  }
  get step(): Step | undefined {
    return this.story?.steps[this.stepIndex];
  }

  /** Changed files that are in no story: the ones the stories file explains, then any it leaves out. */
  get unstoried(): UnstoriedFile[] {
    const listed: UnstoriedFile[] = this.store.doc?.unstoried?.files ?? [];
    const known = new Set(listed.map(f => f.path));
    const storied = this.storiedFiles();
    const missing = (this.changed ?? []).filter(f => !known.has(f) && !storied.has(f));
    return [...listed, ...missing.map(path => ({ path, missing: true }))];
  }

  /** How the changed files are covered, or undefined when the change could not be read from git. */
  get coverage(): { changed: number; storied: number } | undefined {
    const storied = this.storiedFiles();
    return this.changed && { changed: this.changed.length, storied: this.changed.filter(f => storied.has(f)).length };
  }

  /** How the changed lines are covered, or undefined when the change could not be read from git. */
  get lineCoverage(): LineCoverage | undefined {
    if (!this.added) {
      return undefined;
    }
    const shownIn = new Map<string, Set<number>>();
    for (const story of this.stories) {
      for (const step of story.steps) {
        const set = shownIn.get(step.file) ?? new Set<number>();
        step.lines.forEach(l => l.line !== null && set.add(l.line));
        shownIn.set(step.file, set);
      }
    }
    const leftOutFiles = new Set((this.store.doc?.unstoried?.files ?? []).map(f => f.path));
    const testFiles = new Set(this.stories.flatMap(s => s.tests.map(t => t.file)));
    const result: LineCoverage = { total: 0, shown: 0, tests: 0, leftOut: 0, unseen: 0, files: [] };
    for (const [path, lines] of this.added) {
      if (path.startsWith('.stories/')) {
        continue;
      }
      result.total += lines.length;
      const shown = shownIn.get(path);
      if (shown) {
        const unseen = lines.filter(n => !shown.has(n));
        result.shown += lines.length - unseen.length;
        result.unseen += unseen.length;
        if (unseen.length) {
          result.files.push({ path, lines: unseen });
        }
      } else if (testFiles.has(path)) {
        result.tests += lines.length;
      } else if (leftOutFiles.has(path)) {
        result.leftOut += lines.length;
      } else {
        result.unseen += lines.length; // The file is missing from the stories altogether.
      }
    }
    result.files.sort((a, b) => b.lines.length - a.lines.length);
    // Nothing differs from the base: the change is already merged, and there are no lines to count.
    return result.total ? result : undefined;
  }

  /** Number of steps, across all stories, whose excerpt no longer matches the file. */
  get staleSteps(): number {
    return this.staleLines.size;
  }

  /** Everything the panel needs to know about each story beyond what the stories file says. */
  insights(): StoryInsight[] {
    const seen = new Map<string, number>();
    return this.stories.map((story, si) => {
      const mark = this.mark(story);
      const status = this.status(story);
      const steps = story.steps.map((step, i) => {
        const key = stepHash(step);
        const sameAs = seen.get(key) ?? -1;
        if (sameAs < 0) {
          seen.set(key, si);
        }
        const insight: StepInsight = { stale: this.staleLines.get(`${si}:${i}`) ?? [], sameAs, since: null, fresh: [] };
        if (status === 'changed' && mark) {
          const before = mark.steps[step.id];
          if (!before) {
            insight.since = 'new';
            insight.fresh = step.lines.map((_, li) => li);
          } else if (before.hash === key) {
            insight.since = 'same';
          } else {
            insight.since = 'changed';
            const known = new Set(before.lines);
            insight.fresh = step.lines.flatMap((l, li) => (known.has(lineKey(l)) ? [] : [li]));
          }
        }
        return insight;
      });
      return { status, reviewedAt: status === 'new' ? undefined : mark?.at, steps };
    });
  }

  openStory(index: number): void {
    if (!this.stories[index]) {
      return;
    }
    this.view = 'story';
    this.storyIndex = index;
    this.stepIndex = 0;
    this.line = this.stories[index].steps[0].focusLine;
    this.changeEmitter.fire();
    this.navigateEmitter.fire();
  }

  showOverview(): void {
    this.view = 'overview';
    this.changeEmitter.fire();
  }

  selectStep(index: number, line?: number): void {
    const step = this.story?.steps[index];
    if (!step) {
      return;
    }
    this.view = 'story';
    this.stepIndex = index;
    this.line = line ?? step.focusLine;
    this.changeEmitter.fire();
    this.navigateEmitter.fire();
  }

  moveStep(delta: number): void {
    const count = this.story?.steps.length ?? 0;
    this.selectStep(Math.max(0, Math.min(count - 1, this.stepIndex + delta)));
  }

  isReviewed(story: Story): boolean {
    return this.status(story) === 'reviewed';
  }

  /** Reviewed, changed since it was reviewed, or not reviewed yet. */
  status(story: Story): ReviewStatus {
    const entry = this.reviewedMap()[story.id];
    if (!entry) {
      return 'new';
    }
    if (typeof entry === 'string') {
      // A mark from before review marks kept what was read: it only knows the whole story's hash.
      return entry === legacyHash(story) ? 'reviewed' : 'new';
    }
    return entry.hash === storyHash(story) ? 'reviewed' : 'changed';
  }

  reviewedIds(): string[] {
    return this.stories.filter(s => this.isReviewed(s)).map(s => s.id);
  }

  /** Marks the current story reviewed and moves to the next one that is not, or takes the mark back. */
  toggleReviewed(): void {
    const story = this.story;
    if (!story) {
      return;
    }
    const map = { ...this.reviewedMap() };
    if (this.isReviewed(story)) {
      delete map[story.id];
      void this.memento.update(this.reviewedKey(), map);
      this.changeEmitter.fire();
      return;
    }
    map[story.id] = {
      hash: storyHash(story),
      at: new Date().toISOString(),
      steps: Object.fromEntries(story.steps.map(s => [s.id, { hash: stepHash(s), lines: s.lines.map(lineKey) }]))
    };
    void this.memento.update(this.reviewedKey(), map);
    const next = this.stories.findIndex((s, i) => i !== this.storyIndex && this.status(s) !== 'reviewed');
    if (next >= 0) {
      this.openStory(next);
    } else {
      this.showOverview();
    }
  }

  private mark(story: Story): ReviewMark | undefined {
    const entry = this.reviewedMap()[story.id];
    return entry && typeof entry !== 'string' ? entry : undefined;
  }

  private reviewedMap(): Record<string, string | ReviewMark> {
    return this.memento.get<Record<string, string | ReviewMark>>(this.reviewedKey(), {});
  }

  // Reviewed marks are kept per set, so two changes with a story of the same id do not share one.
  private reviewedKey(): string {
    return this.store.setId === DEFAULT_SET ? 'reviewed' : `reviewed:${this.store.setId}`;
  }

  /**
   * Which set to show: the reviewer's pick, else the set named after the branch, else the newest
   * set written on this branch, else the default set, else the newest of all.
   */
  private wantedSet(): string {
    const sets = this.store.sets;
    const has = (id?: string) => !!id && sets.some(s => s.id === id);
    const newest = (list: StorySet[]) => [...list].sort((a, b) => b.modified - a.modified)[0]?.id;
    const own = this.branch ? setIdFor(this.branch) : undefined;
    if (has(this.manual)) {
      return this.manual!;
    }
    if (has(own)) {
      return own!;
    }
    const onBranch = this.branch ? newest(sets.filter(s => s.head === this.branch)) : undefined;
    return onBranch ?? (has(DEFAULT_SET) ? DEFAULT_SET : newest(sets) ?? DEFAULT_SET);
  }

  /** Switches the store to the wanted set. Returns true when that changed the set on screen. */
  private pickSet(): boolean {
    const ids = this.store.sets.map(s => s.id);
    const own = this.branch ? setIdFor(this.branch) : undefined;
    if (own && ids.includes(own) && !this.knownSets.split('\n').includes(own)) {
      this.manual = undefined; // The branch just got its own set: show it.
    }
    this.knownSets = ids.join('\n');
    const wanted = this.wantedSet();
    if (wanted === this.store.setId) {
      return false;
    }
    this.view = 'overview';
    this.storyIndex = 0;
    this.stepIndex = 0;
    this.changed = undefined;
    this.added = undefined;
    this.store.select(wanted);
    return true;
  }

  private clamp(): void {
    if (!this.stories.length) {
      this.view = 'overview';
      this.storyIndex = 0;
      this.stepIndex = 0;
      return;
    }
    this.storyIndex = Math.min(this.storyIndex, this.stories.length - 1);
    this.stepIndex = Math.min(this.stepIndex, this.stories[this.storyIndex].steps.length - 1);
  }

  private storiedFiles(): Set<string> {
    return new Set(this.stories.flatMap(s => [...s.steps.map(step => step.file), ...s.tests.map(t => t.file)]));
  }

  /** Compares every excerpt with its file. Returns true when the set of out-of-date lines changed. */
  private checkFiles(): boolean {
    const files = new Map<string, string[] | undefined>();
    const read = (file: string) => {
      if (!files.has(file)) {
        const open = this.host.openText?.(this.store.abs(file));
        files.set(file, open !== undefined ? open.split(/\r?\n/) : readTextLines(this.store.abs(file)));
      }
      return files.get(file);
    };
    const stale = new Map<string, number[]>();
    this.stories.forEach((story, si) =>
      story.steps.forEach((step, i) => {
        if (step.removed) {
          return; // Removed code is read from the base version, which does not move.
        }
        const lines = read(step.file);
        const off = step.lines.flatMap(l =>
          l.line !== null && (!lines || lines[l.line - 1]?.trim() !== l.text.trim()) ? [l.line] : []
        );
        if (off.length) {
          stale.set(`${si}:${i}`, off);
        }
      })
    );
    const before = JSON.stringify([...this.staleLines]);
    this.staleLines = stale;
    return before !== JSON.stringify([...stale]);
  }

  /** Asks git whether HEAD has moved on from the stories, and which files and lines the change touches. */
  async checkGit(): Promise<void> {
    const branch = await gitBranch(this.store.root);
    if (branch !== this.branch) {
      this.branch = branch;
      this.manual = undefined;
      if (!this.pickSet()) {
        this.changeEmitter.fire();
      }
    }
    const doc = this.store.doc;
    const recorded = doc?.headSha;
    const head = recorded ? await gitHead(this.store.root) : undefined;
    const stale = !!recorded && !!head && !head.startsWith(recorded) && !recorded.startsWith(head);
    const base = doc?.baseSha ?? doc?.base;
    const changed = base
      ? (await changedFiles(this.store.root, base))?.filter(f => !f.startsWith('.stories/')).sort()
      : undefined;
    const added = base ? await addedLines(this.store.root, base) : undefined;
    const sameAdded = JSON.stringify(added && [...added]) === JSON.stringify(this.added && [...this.added]);
    const filesMoved = this.checkFiles();
    if (filesMoved || !sameAdded || stale !== this.stale || changed?.join('\n') !== this.changed?.join('\n')) {
      this.stale = stale;
      this.changed = changed;
      this.added = added;
      this.changeEmitter.fire();
    }
  }

  dispose(): void {
    this.subscriptions.forEach(d => d.dispose());
    this.changeEmitter.dispose();
    this.navigateEmitter.dispose();
  }
}

function sha(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function lineKey(l: { kind: string; text: string }): string {
  return `${l.kind}|${l.text.trim()}`;
}

// Line numbers are left out of the hashes: code that only moved down the file has not changed.
function stepHash(step: Step): string {
  return sha([step.name, step.file, step.removed, step.lines.map(lineKey)]);
}

// A story counts as reviewed only while what it shows is unchanged.
function storyHash(story: Story): string {
  return sha([story.title, story.goal, story.steps.map(s => [s.id, stepHash(s), s.summary ?? '']), story.risks]);
}

function legacyHash(story: Story): string {
  return createHash('sha1').update(JSON.stringify(story)).digest('hex');
}
