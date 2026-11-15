import * as fs from 'fs';
import { listComments, parsePrUrl, postComment, postReply } from './github';
import { PrLink, ReviewComment, resolveLine } from './model';
import { Store } from './store';

/**
 * Review comments as data: saved to comments.json for the agent, or posted to the pull request
 * through the gh CLI and mirrored in the same file. Each editor draws the threads its own way.
 */
export class CommentBook {
  /** @param openText text of a file that is open with unsaved edits, if the editor has it */
  constructor(private readonly store: Store, private readonly openText?: (fsPath: string) => string | undefined) {}

  get pr(): PrLink | undefined {
    return this.store.comments.pr ?? undefined;
  }

  find(id?: string): ReviewComment | undefined {
    return this.store.comments.comments.find(c => c.id === id);
  }

  /** A new comment on 1-based lines of a workspace file, not yet saved. */
  draft(file: string, startLine: number, endLine: number, body: string, source: 'local' | 'pr'): ReviewComment | undefined {
    const text = body.trim();
    if (!file || !text) {
      return undefined;
    }
    return {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      source,
      file,
      startLine,
      endLine,
      text: this.fileLines(file)[endLine - 1]?.trim(),
      status: source === 'local' ? 'waiting' : 'posted',
      messages: [{ author: 'you', at: new Date().toISOString(), text }]
    };
  }

  save(comment: ReviewComment): void {
    this.store.mutateComments(file => {
      file.comments.push(comment);
    });
  }

  /** Posts a drafted comment to the pull request, then saves it. Throws with gh's message when posting fails. */
  async postToPr(comment: ReviewComment, pr: PrLink): Promise<void> {
    comment.github = await postComment(this.store.root, pr, { ...comment, body: comment.messages[0].text });
  }

  /** Adds a reply. A reply on a pull request thread is posted first; throws when that fails. */
  async reply(id: string, body: string): Promise<void> {
    const existing = this.find(id);
    const text = body.trim();
    if (!existing || !text) {
      return;
    }
    let githubId: number | undefined;
    if (existing.source === 'pr') {
      const pr = this.pr;
      if (!pr || !existing.github) {
        throw new Error('Link the pull request again to reply to this thread.');
      }
      githubId = await postReply(this.store.root, pr, existing.github.id, text);
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

  resolve(id: string): void {
    this.store.mutateComments(file => {
      const c = file.comments.find(x => x.id === id);
      if (c) {
        c.resolved = true;
      }
    });
  }

  /** Links a pull request by its URL. Returns undefined when the text is not a pull request link. */
  linkPr(url: string): PrLink | undefined {
    const pr = parsePrUrl(url);
    if (pr) {
      this.store.mutateComments(file => {
        file.pr = pr;
      });
    }
    return pr;
  }

  unlinkPr(): void {
    this.store.mutateComments(file => {
      file.pr = null;
    });
  }

  /** Pulls replies made on GitHub into the mirrored threads. Returns how many were added. */
  async refreshFromPr(): Promise<number> {
    const pr = this.pr;
    if (!pr) {
      return 0;
    }
    const remote = await listComments(this.store.root, pr);
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
    return added;
  }

  /** Where a comment sits now, as 1-based lines: it follows its text when the code has moved. */
  anchor(c: ReviewComment): { startLine: number; endLine: number } {
    const lines = this.fileLines(c.file);
    const endLine = resolveLine(n => lines[n - 1], c.endLine, c.text);
    return { startLine: Math.max(1, c.startLine + (endLine - c.endLine)), endLine };
  }

  private fileLines(file: string): string[] {
    const abs = this.store.abs(file);
    try {
      return (this.openText?.(abs) ?? fs.readFileSync(abs, 'utf8')).split(/\r?\n/);
    } catch {
      return [];
    }
  }
}
