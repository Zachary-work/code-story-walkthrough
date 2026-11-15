import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { changedFiles, gitBranch, gitHead } from './github';
import { Step, Story, UnstoriedFile } from './model';
import { DEFAULT_SET, Store, StorySet, setIdFor } from './store';

/** Where the reviewer is: which story, step and line, and which stories are reviewed. */
export class Session implements vscode.Disposable {
  view: 'overview' | 'story' = 'overview';
  storyIndex = 0;
  stepIndex = 0;
  line = 0;
  stale = false;
  /** Files that differ from the base of the stories, or undefined when that could not be checked. */
  changed?: string[];
  /** The checked-out branch, once git has answered. It decides which story set is shown. */
  branch?: string;
  /** A set the reviewer picked by hand. It holds until the branch changes or the branch gets its own set. */
  private manual?: string;
  private knownSets = '';

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly navigateEmitter = new vscode.EventEmitter<void>();
  /** Fires when anything shown in the panel or tree may have changed. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fires when the editor should follow to the current step and line. */
  readonly onDidNavigate = this.navigateEmitter.event;

  private readonly subscriptions: vscode.Disposable[];

  constructor(readonly store: Store, private readonly memento: vscode.Memento) {
    // .git/HEAD changes on a branch switch. Window focus covers worktrees, where .git is a file.
    const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(store.root), '.git/HEAD'));
    head.onDidChange(() => void this.checkGit());
    this.subscriptions = [
      store.onDidChange(() => {
        if (this.pickSet()) {
          return; // Switching sets reloads the store, which lands here again.
        }
        this.clamp();
        this.changeEmitter.fire();
        void this.checkGit();
      }),
      vscode.workspace.onDidSaveTextDocument(() => void this.checkGit()),
      vscode.window.onDidChangeWindowState(state => state.focused && void this.checkGit()),
      head
    ];
    this.pickSet();
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
    return this.reviewedMap()[story.id] === hash(story);
  }

  reviewedIds(): string[] {
    return this.stories.filter(s => this.isReviewed(s)).map(s => s.id);
  }

  /** Marks the current story reviewed and moves to the next unreviewed one, or toggles it back. */
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
    map[story.id] = hash(story);
    void this.memento.update(this.reviewedKey(), map);
    const next = this.stories.findIndex((s, i) => i !== this.storyIndex && map[s.id] !== hash(s));
    if (next >= 0) {
      this.openStory(next);
    } else {
      this.showOverview();
    }
  }

  private reviewedMap(): Record<string, string> {
    return this.memento.get<Record<string, string>>(this.reviewedKey(), {});
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
    return new Set(this.stories.flatMap(s => s.steps.map(step => step.file)));
  }

  /** Asks git whether HEAD has moved on from the stories, and which files the change touches. */
  private async checkGit(): Promise<void> {
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
    if (stale !== this.stale || changed?.join('\n') !== this.changed?.join('\n')) {
      this.stale = stale;
      this.changed = changed;
      this.changeEmitter.fire();
    }
  }

  dispose(): void {
    this.subscriptions.forEach(d => d.dispose());
    this.changeEmitter.dispose();
    this.navigateEmitter.dispose();
  }
}

// A story counts as reviewed only while its content is unchanged.
function hash(story: Story): string {
  return createHash('sha1').update(JSON.stringify(story)).digest('hex');
}
