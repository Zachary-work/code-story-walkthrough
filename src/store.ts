import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentsFile, StoriesDoc, parseComments, parseStories } from './model';

/** The set made of .stories/stories.json itself, from before each change had its own folder. */
export const DEFAULT_SET = 'default';

/** One change's stories and comments: a folder in .stories/, normally named after the branch. */
export interface StorySet {
  id: string;
  title: string;
  /** The branch the stories were written on. */
  head?: string;
  stories: number;
  modified: number;
}

/** Folder name of the story set for a branch: feature/promo-codes becomes feature-promo-codes. */
export function setIdFor(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || DEFAULT_SET;
}

/** Reads and watches the story sets of one workspace folder, and holds the one being shown. */
export class Store implements vscode.Disposable {
  doc?: StoriesDoc;
  error?: string;
  comments: CommentsFile = { version: 1, comments: [] };
  sets: StorySet[] = [];
  setId = DEFAULT_SET;

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;

  constructor(readonly root: string) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '.stories/**/*.json')
    );
    const changed = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 100);
    };
    this.watcher.onDidChange(changed);
    this.watcher.onDidCreate(changed);
    this.watcher.onDidDelete(changed);
    this.read();
  }

  /** Folder of the set being shown. */
  get dir(): string {
    return this.dirOf(this.setId);
  }
  get storiesPath(): string {
    return path.join(this.dir, 'stories.json');
  }
  get commentsPath(): string {
    return path.join(this.dir, 'comments.json');
  }

  dirOf(setId: string): string {
    const base = path.join(this.root, '.stories');
    return setId === DEFAULT_SET ? base : path.join(base, setId);
  }

  abs(file: string): string {
    return path.join(this.root, file);
  }

  /** Workspace-relative path with forward slashes, or undefined when outside the workspace. */
  rel(fsPath: string): string | undefined {
    const rel = path.relative(this.root, fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.replace(/\\/g, '/');
  }

  reload(): void {
    this.read();
    this.emitter.fire();
  }

  /** Shows another set. Its comments replace the current ones. */
  select(setId: string): void {
    if (setId === this.setId) {
      return;
    }
    this.setId = setId;
    this.comments = { version: 1, comments: [] };
    this.reload();
  }

  /** Moves a set's stories and comments to the trash. */
  async deleteSet(setId: string): Promise<void> {
    const dir = this.dirOf(setId);
    const targets = setId === DEFAULT_SET ? ['stories.json', 'comments.json'].map(f => path.join(dir, f)) : [dir];
    for (const target of targets.filter(t => fs.existsSync(t))) {
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
    }
    this.reload();
  }

  /** Re-reads comments.json, applies the change and writes it back, so agent edits are not overwritten. */
  mutateComments(change: (file: CommentsFile) => void): void {
    this.readComments();
    change(this.comments);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.commentsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.comments, null, 2) + '\n');
    fs.renameSync(tmp, this.commentsPath);
    this.emitter.fire();
  }

  private read(): void {
    this.error = undefined;
    this.doc = undefined;
    this.sets = this.listSets();
    if (fs.existsSync(this.storiesPath)) {
      try {
        this.doc = parseStories(fs.readFileSync(this.storiesPath, 'utf8'));
      } catch (e) {
        this.error = `Could not read ${this.rel(this.storiesPath)}. ${(e as Error).message}`;
      }
    }
    this.readComments();
  }

  /** Every folder in .stories/ that has a stories.json, plus .stories/stories.json itself as the default set. */
  private listSets(): StorySet[] {
    const base = path.join(this.root, '.stories');
    let names: string[] = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== DEFAULT_SET).map(e => e.name);
    } catch {
      return [];
    }
    const sets: StorySet[] = [];
    for (const id of [DEFAULT_SET, ...names.sort()]) {
      const file = path.join(this.dirOf(id), 'stories.json');
      if (!fs.existsSync(file)) {
        continue;
      }
      const set: StorySet = { id, title: id, stories: 0, modified: fs.statSync(file).mtimeMs };
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        set.title = typeof doc.title === 'string' && doc.title ? doc.title : id;
        set.head = typeof doc.head === 'string' ? doc.head : undefined;
        set.stories = Array.isArray(doc.stories) ? doc.stories.length : 0;
      } catch {
        // Still listed, so a set the agent is part-way through writing can be picked.
      }
      sets.push(set);
    }
    return sets;
  }

  private readComments(): void {
    if (!fs.existsSync(this.commentsPath)) {
      this.comments = { version: 1, comments: [] };
      return;
    }
    try {
      this.comments = parseComments(fs.readFileSync(this.commentsPath, 'utf8'));
    } catch {
      // Keep the last good copy: the agent may be part-way through writing the file.
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
