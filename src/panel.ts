import * as vscode from 'vscode';
import { CommentUi } from './comments';
import { handlePanelMessage } from './core/controller';
import { Session } from './core/session';
import { panelState } from './core/view';
import { EditorFollower } from './editor';

/** The story panel: a webview beside the editor that shows the overview and one story at a time. */
export class StoryPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: Session,
    private readonly comments: CommentUi,
    private readonly editor: EditorFollower,
    private readonly deleteSet: () => unknown
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
    void this.panel?.webview.postMessage({ type: 'state', state: panelState(this.session) });
  }

  private async receive(m: any): Promise<void> {
    if (m?.type === 'ready') {
      return this.post();
    }
    await handlePanelMessage(m, this.session, {
      openDiff: (file, line) => this.editor.openDiff(file, line),
      openFile: (file, line) => this.editor.open(file, line, line),
      copy: text => vscode.env.clipboard.writeText(text),
      deleteSet: this.deleteSet,
      installSkill: () => vscode.commands.executeCommand('codeStories.installSkill'),
      linkPr: url => this.comments.linkPr(url),
      unlinkPr: () => this.comments.unlinkPr(),
      refreshPr: () => this.comments.refreshFromPr(),
      openComment: id => this.comments.open(id)
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.panel?.dispose();
  }
}
