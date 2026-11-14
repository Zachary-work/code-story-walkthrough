import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { gitHead } from './github';
import { Step, Story } from './model';
import { Store } from './store';

/** Where the reviewer is: which story, step and line, and which stories are reviewed. */
export class Session implements vscode.Disposable {
  view: 'overview' | 'story' = 'overview';
  storyIndex = 0;
  stepIndex = 0;
  line = 0;
  stale = false;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly navigateEmitter = new vscode.EventEmitter<void>();
  /** Fires when anything shown in the panel or tree may have changed. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fires when the editor should follow to the current step and line. */
  readonly onDidNavigate = this.navigateEmitter.event;

  constructor(readonly store: Store, private readonly memento: vscode.Memento) {
    store.onDidChange(() => {
      this.clamp();
      this.changeEmitter.fire();
      void this.checkStale();
    });
    void this.checkStale();
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
      void this.memento.update('reviewed', map);
      this.changeEmitter.fire();
      return;
    }
    map[story.id] = hash(story);
    void this.memento.update('reviewed', map);
    const next = this.stories.findIndex((s, i) => i !== this.storyIndex && map[s.id] !== hash(s));
    if (next >= 0) {
      this.openStory(next);
    } else {
      this.showOverview();
    }
  }

  private reviewedMap(): Record<string, string> {
    return this.memento.get<Record<string, string>>('reviewed', {});
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

  private async checkStale(): Promise<void> {
    const recorded = this.store.doc?.headSha;
    const head = recorded ? await gitHead(this.store.root) : undefined;
    const stale = !!recorded && !!head && !head.startsWith(recorded) && !recorded.startsWith(head);
    if (stale !== this.stale) {
      this.stale = stale;
      this.changeEmitter.fire();
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.navigateEmitter.dispose();
  }
}

// A story counts as reviewed only while its content is unchanged.
function hash(story: Story): string {
  return createHash('sha1').update(JSON.stringify(story)).digest('hex');
}
