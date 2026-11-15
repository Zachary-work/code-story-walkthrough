import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Step, Story, resolveLine } from './model';
import { Session } from './session';

/** Keeps the real editor in step with the story: opens files, reveals lines, marks changed and calling lines. */
export class EditorFollower implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });
  private readonly call = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground')
  });
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly session: Session) {
    this.subscriptions = [
      session.onDidNavigate(() => void this.reveal()),
      session.onDidChange(() => this.decorate()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate())
    ];
  }

  async reveal(): Promise<void> {
    const step = this.session.step;
    if (!step) {
      return;
    }
    const wanted = this.session.line || step.focusLine;
    const text = step.lines.find(l => l.line === wanted)?.text;
    await this.open(step.file, wanted, wanted, text);
  }

  /** Opens a workspace file in the first editor column with the given 1-based lines selected. */
  async open(file: string, startLine: number, endLine: number, endText?: string): Promise<vscode.TextEditor | undefined> {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.session.store.abs(file)));
    } catch {
      void vscode.window.showWarningMessage(`Code Stories: ${file} could not be opened.`);
      return undefined;
    }
    const end = clamp(doc, resolveLine(lineReader(doc), endLine, endText));
    const start = clamp(doc, startLine + (end - endLine));
    const range = new vscode.Range(start - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      selection: start === end ? new vscode.Range(range.start, range.start) : range
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.decorate();
    return editor;
  }

  /** Shows the working copy of a file against the base the stories were written for. */
  async openDiff(file: string, line?: number): Promise<void> {
    const store = this.session.store;
    const uri = vscode.Uri.file(store.abs(file));
    const base = store.doc?.baseSha ?? store.doc?.base;
    const git = vscode.extensions.getExtension('vscode.git');
    if (!base || !git) {
      await this.open(file, line ?? 1, line ?? 1);
      return;
    }
    const api = (git.isActive ? git.exports : await git.activate()).getAPI(1);
    const title = `${path.basename(file)} (${store.doc?.base ?? base.slice(0, 7)} ↔ working tree)`;
    if (!fs.existsSync(uri.fsPath)) {
      // Deleted in this change: there is no working copy to compare, so show what was removed.
      await vscode.window.showTextDocument(api.toGitUri(uri, base), { viewColumn: vscode.ViewColumn.One });
      return;
    }
    const selection = line ? new vscode.Range(line - 1, 0, line - 1, 0) : undefined;
    await vscode.commands.executeCommand('vscode.diff', api.toGitUri(uri, base), uri, title, {
      viewColumn: vscode.ViewColumn.One,
      selection
    });
  }

  private decorate(): void {
    const story = this.session.view === 'story' ? this.session.story : undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      const file = editor.document.uri.scheme === 'file' ? this.session.store.rel(editor.document.uri.fsPath) : undefined;
      const added: vscode.Range[] = [];
      const calls: vscode.DecorationOptions[] = [];
      if (story && file) {
        const read = lineReader(editor.document);
        story.steps.forEach((step, index) => {
          if (step.file !== file) {
            return;
          }
          for (const l of step.lines) {
            if (l.line === null || l.kind === 'context') {
              continue;
            }
            const n = clamp(editor.document, resolveLine(read, l.line, l.text));
            const range = new vscode.Range(n - 1, 0, n - 1, 0);
            if (l.kind === 'add') {
              added.push(range);
            } else {
              calls.push({ range, renderOptions: { after: calleeHint(story, index) } });
            }
          }
        });
      }
      editor.setDecorations(this.added, added);
      editor.setDecorations(this.call, calls);
    }
  }

  dispose(): void {
    this.added.dispose();
    this.call.dispose();
    this.subscriptions.forEach(d => d.dispose());
  }
}

function calleeHint(story: Story, callerIndex: number): vscode.ThemableDecorationAttachmentRenderOptions | undefined {
  const calleeIndex = story.steps.findIndex((s: Step) => s.caller === callerIndex);
  if (calleeIndex < 0) {
    return undefined;
  }
  const callee = story.steps[calleeIndex];
  return {
    contentText: `→ calls step ${calleeIndex + 1}${callee.changed ? ', changed' : ''}`,
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    margin: '0 0 0 2em'
  };
}

function lineReader(doc: vscode.TextDocument): (n: number) => string | undefined {
  return n => (n >= 1 && n <= doc.lineCount ? doc.lineAt(n - 1).text : undefined);
}

function clamp(doc: vscode.TextDocument, line: number): number {
  return Math.max(1, Math.min(doc.lineCount, line));
}
