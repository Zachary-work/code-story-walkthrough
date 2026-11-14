import * as path from 'path';
import * as vscode from 'vscode';
import { CommentUi } from './comments';
import { EditorFollower } from './editor';
import { statusLabel } from './model';
import { Session } from './session';

export const AGENT_PROMPT = 'Read and address my review comments';
export const CREATE_PROMPT = 'Create code stories for this branch';

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

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'codeStories.panel',
      'Stories',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
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
    return {
      error: store.error,
      doc: store.doc,
      view: session.view,
      storyIndex: session.storyIndex,
      stepIndex: session.stepIndex,
      line: session.line,
      reviewed: session.reviewedIds(),
      stale: session.stale,
      pr: pr ? { number: pr.number, url: pr.url } : null,
      waiting: open.filter(c => c.source === 'local' && c.status === 'waiting').length,
      agentPrompt: AGENT_PROMPT,
      createPrompt: CREATE_PROMPT,
      comments: open.map(c => ({
        id: c.id,
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
      case 'unstoried':
        return vscode.commands.executeCommand('codeStories.showUnstoried');
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

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}
