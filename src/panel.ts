import * as path from 'path';
import * as vscode from 'vscode';
import { CommentUi } from './comments';
import { EditorFollower } from './editor';
import { statusLabel } from './model';
import { Session } from './session';

export const AGENT_PROMPT = 'Read and address my review comments';
export const CREATE_PROMPT = 'Create code stories for this branch';
export const REFRESH_PROMPT = 'Refresh the code stories so every changed line is covered';
export const MISSING_REASON = 'Missing from the stories file';

/** The story panel: a webview beside the editor that shows the overview and one story at a time. */
export class StoryPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly comments: CommentUi,
    private readonly editor: EditorFollower
  ) {
    this.subscription = session.onDidChange(() => this.post());
  }

  /** Opens or reveals the panel. Pass preserveFocus to leave the keyboard in the current editor. */
  show(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'codeStories.panel',
      'Stories',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] }
    );
    const webview = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))}">
<title>Stories</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))}"></script>
</body>
</html>`;
    webview.onDidReceiveMessage(m => void this.receive(m));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private post(): void {
    void this.panel?.webview.postMessage({ type: 'state', state: this.state() });
  }

  private state() {
    const { session } = this;
    const store = session.store;
    const pr = store.comments.pr ?? undefined;
    const open = store.comments.comments.filter(c => !c.resolved);
    const lines = session.lineCoverage;
    // Only the storied files' changed lines go to the panel: it uses them to say what an excerpt leaves out.
    const storied = new Set(session.stories.flatMap(s => s.steps.map(step => step.file)));
    const added: Record<string, number[]> = {};
    for (const [file, numbers] of session.added ?? []) {
      if (storied.has(file)) {
        added[file] = numbers;
      }
    }
    return {
      insights: session.insights(),
      staleSteps: session.staleSteps,
      lines: lines ? { ...lines, files: lines.files.map(f => ({ path: f.path, count: f.lines.length, first: f.lines[0], ranges: ranges(f.lines) })) } : null,
      added,
      error: store.error,
      doc: store.doc,
      sets: store.sets.map(s => ({ id: s.id, title: s.title, stories: s.stories })),
      setId: store.setId,
      foreign: session.foreign ?? null,
      branch: session.branch ?? null,
      view: session.view,
      storyIndex: session.storyIndex,
      stepIndex: session.stepIndex,
      line: session.line,
      reviewed: session.reviewedIds(),
      stale: session.stale,
      unstoried: session.unstoried,
      coverage: session.coverage ?? null,
      pr: pr ? { number: pr.number, url: pr.url } : null,
      waiting: open.filter(c => c.source === 'local' && c.status === 'waiting').length,
      agentPrompt: AGENT_PROMPT,
      createPrompt: CREATE_PROMPT,
      refreshPrompt: REFRESH_PROMPT,
      comments: open.map(c => ({
        id: c.id,
        file: c.file,
        where: `${path.posix.basename(c.file)}:${c.startLine === c.endLine ? c.endLine : `${c.startLine}-${c.endLine}`}`,
        status: c.status,
        statusLabel: statusLabel(c, pr?.number),
        first: c.messages[0]?.text ?? ''
      }))
    };
  }

  private async receive(m: any): Promise<void> {
    const { session } = this;
    switch (m.type) {
      case 'ready':
        return this.post();
      case 'selectSet':
        return session.store.sets.some(s => s.id === m.id) ? session.selectSet(m.id) : undefined;
      case 'deleteSet':
        return vscode.commands.executeCommand('codeStories.deleteSet');
      case 'openStory':
        return session.openStory(m.index);
      case 'overview':
        return session.showOverview();
      case 'step':
        return session.selectStep(m.index, m.line);
      case 'moveStep':
        return session.moveStep(m.delta);
      case 'toggleReviewed':
        return session.toggleReviewed();
      case 'openDiff': {
        const step = session.story?.steps[m.index];
        return step && this.editor.openDiff(step.file, step.focusLine);
      }
      case 'openFile':
        return session.selectStep(m.index);
      case 'openUnstoried': {
        const file = session.unstoried.find(f => f.path === m.path);
        return file && this.editor.openDiff(file.path);
      }
      case 'openLines':
        return typeof m.path === 'string' && session.lineCoverage?.files.some(f => f.path === m.path)
          ? this.editor.openDiff(m.path, Number(m.line) || undefined)
          : undefined;
      case 'openTest': {
        const test = session.stories[m.story]?.tests[m.index];
        if (test) {
          await this.editor.open(test.file, test.line ?? 1, test.line ?? 1);
        }
        return;
      }
      case 'copySummary':
        return vscode.env.clipboard.writeText(this.summary());
      case 'linkPr':
        await this.comments.linkPr(m.url);
        return;
      case 'unlinkPr':
        return this.comments.unlinkPr();
      case 'refreshPr':
        return this.comments.refreshFromPr();
      case 'openComment':
        return this.comments.open(m.id);
      case 'copy':
        return vscode.env.clipboard.writeText(m.text);
      case 'installSkill':
        return vscode.commands.executeCommand('codeStories.installSkill');
    }
  }

  /** Where the review stands, as plain text to paste into a pull request or a chat. */
  private summary(): string {
    const { session } = this;
    const doc = session.store.doc;
    if (!doc) {
      return '';
    }
    const insights = session.insights();
    const done = insights.filter(i => i.status === 'reviewed').length;
    const out = [`Review of "${doc.title}"${doc.head && doc.base ? ` (${doc.head} compared with ${doc.base})` : ''}`, ''];
    out.push(`Stories: ${done} of ${doc.stories.length} reviewed`);
    doc.stories.forEach((story, i) => {
      const status = insights[i].status;
      const note = status === 'changed' ? ' (changed since it was reviewed)' : '';
      out.push(`- [${status === 'reviewed' ? 'x' : ' '}] ${i + 1}. ${story.title}${note}`);
    });
    const lines = session.lineCoverage;
    if (lines) {
      out.push('', `Changed lines: ${lines.shown} of ${lines.total} are shown in a story, ${lines.tests} are in its tests, ${lines.leftOut} are in files left out with a reason, ${lines.unseen} are shown nowhere`);
    }
    if (session.staleSteps) {
      out.push(`Out of date: ${session.staleSteps} step${session.staleSteps === 1 ? '' : 's'} no longer match the code`);
    }
    const untested = doc.stories.filter(s => !s.tests.length).map(s => s.title);
    if (untested.length) {
      out.push(`No test listed for: ${untested.join('; ')}`);
    }
    const open = session.store.comments.comments.filter(c => !c.resolved);
    const waiting = open.filter(c => c.source === 'local' && c.status === 'waiting').length;
    out.push(`Comments: ${open.length} open, ${waiting} waiting for the agent`);
    return out.join('\n');
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}

/** Line numbers as short text: 64 to 74, 80. */
function ranges(lines: number[]): string {
  const parts: string[] = [];
  let start = lines[0];
  let end = lines[0];
  for (const n of [...lines.slice(1), Number.NaN]) {
    if (n === end + 1) {
      end = n;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start} to ${end}`);
    start = end = n;
  }
  return parts.slice(0, 4).join(', ') + (parts.length > 4 ? ', and more' : '');
}
