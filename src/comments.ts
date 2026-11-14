import * as fs from 'fs';
import * as vscode from 'vscode';
import { EditorFollower } from './editor';
import { listComments, parsePrUrl, postComment, postReply } from './github';
import { PrLink, ReviewComment, authorName, rangeText, resolveLine, statusLabel } from './model';
import { Store } from './store';

/**
 * Review comments in the editor gutter. Local comments are saved to .stories/comments.json for the
 * agent; PR comments are posted to GitHub through the gh CLI and mirrored in the same file.
 */
export class CommentUi implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('codeStories', 'Code Stories');
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly ids = new WeakMap<vscode.CommentThread, string>();
  private readonly shown = new Map<string, string>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: Store, private readonly editor: EditorFollower) {
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
    return this.store.comments.pr ?? undefined;
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
      comment.github = await progress(`Posting to PR #${pr.number}`, () =>
        postComment(this.store.root, pr, { ...comment, body: reply.text })
      );
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
    const existing = this.store.comments.comments.find(c => c.id === id);
    const text = reply.text.trim();
    if (!existing || !text) {
      return;
    }
    let githubId: number | undefined;
    if (existing.source === 'pr') {
      const pr = this.pr;
      if (!pr || !existing.github) {
        void vscode.window.showWarningMessage('Link the pull request again to reply to this thread.');
        return;
      }
      try {
        githubId = await progress(`Replying on PR #${pr.number}`, () =>
          postReply(this.store.root, pr, existing.github!.id, text)
        );
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not reply on PR #${pr.number}. ${(e as Error).message}`);
        return;
      }
    }
    this.store.mutateComments(file => {
      const c = file.comments.find(x => x.id === id);
      if (!c) {
        return;
      }
      c.messages.push({ author: 'you', at: new Date().toISOString(), text, githubId });
      if (c.source === 'local') {
        c.status = 'waiting';
      }
    });
  }

  resolve(thread: vscode.CommentThread): void {
    const id = this.ids.get(thread);
    if (!id) {
      thread.dispose();
      return;
    }
    this.store.mutateComments(file => {
      const c = file.comments.find(x => x.id === id);
      if (c) {
        c.resolved = true;
      }
    });
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
    const pr = parsePrUrl(input);
    if (!pr) {
      void vscode.window.showWarningMessage('That is not a pull request link. Use one like https://github.com/owner/repo/pull/123.');
      return undefined;
    }
    this.store.mutateComments(file => {
      file.pr = pr;
    });
    return pr;
  }

  unlinkPr(): void {
    this.store.mutateComments(file => {
      file.pr = null;
    });
  }

  /** Pulls replies made on GitHub into the mirrored PR threads. */
  async refreshFromPr(): Promise<void> {
    const pr = this.pr;
    if (!pr) {
      void vscode.window.showInformationMessage('No pull request is linked.');
      return;
    }
    let remote;
    try {
      remote = await progress(`Fetching replies from PR #${pr.number}`, () => listComments(this.store.root, pr));
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not read PR #${pr.number}. ${(e as Error).message}`);
      return;
    }
    let added = 0;
    this.store.mutateComments(file => {
      for (const c of file.comments) {
        if (c.source !== 'pr' || !c.github) {
          continue;
        }
        const known = new Set(c.messages.map(m => m.githubId));
        for (const r of remote) {
          if (r.replyTo === c.github.id && !known.has(r.id)) {
            c.messages.push({ author: r.user, at: r.at, text: r.body, githubId: r.id });
            added++;
          }
        }
        c.messages.sort((a, b) => a.at.localeCompare(b.at));
      }
    });
    void vscode.window.showInformationMessage(added ? `Added ${added} repl${added === 1 ? 'y' : 'ies'} from PR #${pr.number}.` : 'No new replies.');
  }

  /** Opens the file at a comment and expands its thread. */
  async open(id: string): Promise<void> {
    const c = this.store.comments.comments.find(x => x.id === id);
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
    const text = reply.text.trim();
    if (!file || !text) {
      return undefined;
    }
    const range = reply.thread.range;
    const start = (range?.start.line ?? 0) + 1;
    let end = (range?.end.line ?? 0) + 1;
    if (range && end > start && range.end.character === 0) {
      end--;
    }
    return {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      source,
      file,
      startLine: start,
      endLine: end,
      text: this.fileLines(file)[end - 1]?.trim(),
      status: source === 'local' ? 'waiting' : 'posted',
      messages: [{ author: 'you', at: new Date().toISOString(), text }]
    };
  }

  private adopt(thread: vscode.CommentThread, comment: ReviewComment): void {
    // Register the thread before saving so the sync that follows fills it instead of creating a second one.
    this.threads.set(comment.id, thread);
    this.ids.set(thread, comment.id);
    this.store.mutateComments(file => {
      file.comments.push(comment);
    });
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
      const range = this.rangeOf(c);
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

  private rangeOf(c: ReviewComment): vscode.Range {
    const lines = this.fileLines(c.file);
    const end = resolveLine(n => lines[n - 1], c.endLine, c.text);
    const start = Math.max(1, c.startLine + (end - c.endLine));
    return new vscode.Range(start - 1, 0, end - 1, 0);
  }

  private fileLines(file: string): string[] {
    const uri = vscode.Uri.file(this.store.abs(file));
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    try {
      return (open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8')).split(/\r?\n/);
    } catch {
      return [];
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
