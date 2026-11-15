import * as fs from 'fs';
import * as vscode from 'vscode';
import { CommentBook } from './core/comments';
import { parsePrUrl } from './core/github';
import { PrLink, ReviewComment, authorName, rangeText, statusLabel } from './core/model';
import { Store } from './core/store';
import { EditorFollower } from './editor';

/**
 * Review comments in the editor gutter. The comments themselves live in the shared CommentBook;
 * this class draws them as VS Code comment threads.
 */
export class CommentUi implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('codeStories', 'Code Stories');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly shown = new Map<string, string>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: Store, private readonly book: CommentBook, private readonly editor: EditorFollower) {
    this.controller.options = {
      prompt: 'Add a review comment',
      placeHolder: 'What should change here, or what is unclear?'
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: doc => {
        const rel = doc.uri.scheme === 'file' ? store.rel(doc.uri.fsPath) : undefined;
        if (!rel || rel.startsWith('.stories/') || !fs.existsSync(store.dir)) {
          return undefined;
        }
        return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
      }
    };
    this.subscription = store.onDidChange(() => this.sync());
    this.sync();
  }

  get pr(): PrLink | undefined {
    return this.book.pr;
  }

  // --- commands -------------------------------------------------------------------------------

  addLocal(reply: vscode.CommentReply): void {
    if (this.ids.has(reply.thread)) {
      void this.reply(reply);
      return;
    }
    const comment = this.draft(reply, 'local');
    if (!comment) {
      return;
    }
    this.adopt(reply.thread, comment);
  }

  async addToPr(reply: vscode.CommentReply): Promise<void> {
    if (this.ids.has(reply.thread)) {
      return this.reply(reply);
    }
    const pr = this.pr ?? (await this.linkPr());
    const comment = this.draft(reply, 'pr');
    if (!pr || !comment) {
      return;
    }
    try {
      await progress(`Posting to PR #${pr.number}`, () => this.book.postToPr(comment, pr));
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Could not post to PR #${pr.number}. ${(e as Error).message} The lines must be part of the pull request's diff and pushed.`
      );
      return;
    }
    this.adopt(reply.thread, comment);
  }

  async reply(reply: vscode.CommentReply): Promise<void> {
    const id = this.ids.get(reply.thread);
    const existing = this.book.find(id);
    if (!id || !existing) {
      return;
    }
    try {
      if (existing.source === 'pr') {
        await progress(`Replying on PR #${this.pr?.number ?? ''}`, () => this.book.reply(id, reply.text));
      } else {
        await this.book.reply(id, reply.text);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not reply. ${(e as Error).message}`);
    }
  }

  resolve(thread: vscode.CommentThread): void {
    const id = this.ids.get(thread);
    if (!id) {
      thread.dispose();
      return;
    }
    this.book.resolve(id);
  }

  async linkPr(url?: string): Promise<PrLink | undefined> {
    const input =
      url ??
      (await vscode.window.showInputBox({
        title: 'Link a pull request',
        prompt: 'Pull request link',
        placeHolder: 'https://github.com/your-org/your-repo/pull/482',
        validateInput: v => (parsePrUrl(v) ? undefined : 'Enter a link like https://github.com/owner/repo/pull/123')
      }));
    if (input === undefined) {
      return undefined;
    }
    const pr = this.book.linkPr(input);
    if (!pr) {
      void vscode.window.showWarningMessage('That is not a pull request link. Use one like https://github.com/owner/repo/pull/123.');
    }
    return pr;
  }

  unlinkPr(): void {
    this.book.unlinkPr();
  }

  /** Pulls replies made on GitHub into the mirrored PR threads. */
  async refreshFromPr(): Promise<void> {
    const pr = this.pr;
    if (!pr) {
      void vscode.window.showInformationMessage('No pull request is linked.');
      return;
    }
    try {
      const added = await progress(`Fetching replies from PR #${pr.number}`, () => this.book.refreshFromPr());
      void vscode.window.showInformationMessage(added ? `Added ${added} repl${added === 1 ? 'y' : 'ies'} from PR #${pr.number}.` : 'No new replies.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not read PR #${pr.number}. ${(e as Error).message}`);
    }
  }

  /** Opens the file at a comment and expands its thread. */
  async open(id: string): Promise<void> {
    const c = this.book.find(id);
    if (!c) {
      return;
    }
    await this.editor.open(c.file, c.startLine, c.endLine, c.text);
    const thread = this.threads.get(id);
    if (thread) {
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  // --- threads --------------------------------------------------------------------------------

  private draft(reply: vscode.CommentReply, source: 'local' | 'pr'): ReviewComment | undefined {
    const file = this.store.rel(reply.thread.uri.fsPath);
    if (!file) {
      return undefined;
    }
    const range = reply.thread.range;
    const start = (range?.start.line ?? 0) + 1;
    let end = (range?.end.line ?? 0) + 1;
    if (range && end > start && range.end.character === 0) {
      end--;
    }
    return this.book.draft(file, start, end, reply.text, source);
  }

  private adopt(thread: vscode.CommentThread, comment: ReviewComment): void {
    // Register the thread before saving so the sync that follows fills it instead of creating a second one.
    this.threads.set(comment.id, thread);
    this.ids.set(thread, comment.id);
    this.book.save(comment);
  }

  private sync(): void {
    void vscode.commands.executeCommand('setContext', 'codeStories.prLinked', !!this.pr);
    const live = new Set<string>();
    for (const c of this.store.comments.comments) {
      if (c.resolved || !c.file || !c.id) {
        continue;
      }
      live.add(c.id);
      const signature = JSON.stringify([c, this.pr?.number]);
      const at = this.book.anchor(c);
      const range = new vscode.Range(at.startLine - 1, 0, at.endLine - 1, 0);
      let thread = this.threads.get(c.id);
      if (!thread) {
        thread = this.controller.createCommentThread(vscode.Uri.file(this.store.abs(c.file)), range, []);
        this.threads.set(c.id, thread);
        this.ids.set(thread, c.id);
      } else if (!thread.range || !thread.range.isEqual(range)) {
        thread.range = range;
      }
      if (this.shown.get(c.id) === signature) {
        continue;
      }
      this.shown.set(c.id, signature);
      const where = rangeText(c.startLine, c.endLine);
      const destination = c.source === 'local' ? 'Local, for your agent' : `On PR #${this.pr?.number ?? ''}`.trim();
      thread.label = `${statusLabel(c, this.pr?.number)} · ${destination}, ${where}`;
      thread.contextValue = c.source;
      thread.canReply = true;
      thread.comments = c.messages.map(m => ({
        body: new vscode.MarkdownString(m.text),
        mode: vscode.CommentMode.Preview,
        author: { name: authorName(m.author) },
        timestamp: new Date(m.at)
      }));
    }
    for (const [id, thread] of this.threads) {
      if (!live.has(id)) {
        thread.dispose();
        this.threads.delete(id);
        this.shown.delete(id);
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.controller.dispose();
  }
}

function progress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}
