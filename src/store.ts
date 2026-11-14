import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentsFile, StoriesDoc, parseComments, parseStories } from './model';

/** Reads and watches .stories/stories.json and .stories/comments.json for one workspace folder. */
export class Store implements vscode.Disposable {
  doc?: StoriesDoc;
  error?: string;
  comments: CommentsFile = { version: 1, comments: [] };

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;

  constructor(readonly root: string) {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '.stories/*.json')
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

  get dir(): string {
    return path.join(this.root, '.stories');
  }
  get storiesPath(): string {
    return path.join(this.dir, 'stories.json');
  }
  get commentsPath(): string {
    return path.join(this.dir, 'comments.json');
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
    if (fs.existsSync(this.storiesPath)) {
      try {
        this.doc = parseStories(fs.readFileSync(this.storiesPath, 'utf8'));
      } catch (e) {
        this.error = `Could not read .stories/stories.json. ${(e as Error).message}`;
      }
    }
    this.readComments();
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
