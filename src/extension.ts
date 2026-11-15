import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentUi } from './comments';
import { EditorFollower } from './editor';
import { AGENT_PROMPT, MISSING_REASON, StoryPanel } from './panel';
import { Session } from './session';
import { Store } from './store';
import { StoryTree } from './tree';

const SKILL_NAME = 'code-stories';

export function activate(context: vscode.ExtensionContext): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders.find(f => fs.existsSync(path.join(f.uri.fsPath, '.stories'))) ?? folders[0];
  const register = (id: string, run: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, run));

  register('codeStories.installSkill', () => installSkill(context, folder));

  if (!folder) {
    register('codeStories.open', () => vscode.window.showInformationMessage('Open a folder to use Code Stories.'));
    return;
  }

  const store = new Store(folder.uri.fsPath);
  const session = new Session(store, context.workspaceState);
  const editor = new EditorFollower(session);
  const comments = new CommentUi(store, editor);
  const panel = new StoryPanel(context.extensionUri, session, comments, editor);
  const tree = new StoryTree(session);
  context.subscriptions.push(
    store,
    session,
    editor,
    comments,
    panel,
    tree,
    vscode.window.registerTreeDataProvider('codeStories.stories', tree)
  );

  register('codeStories.open', () => panel.show());

  // Opening .stories/stories.json brings up the panel beside it.
  const showForStoriesFile = (active?: vscode.TextEditor) => {
    if (active?.document.uri.scheme === 'file' && store.rel(active.document.uri.fsPath) === '.stories/stories.json') {
      panel.show(true);
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(showForStoriesFile));
  showForStoriesFile(vscode.window.activeTextEditor);
  register('codeStories.openStory', (index: number) => {
    panel.show();
    session.openStory(index);
  });
  register('codeStories.nextStep', () => session.moveStep(1));
  register('codeStories.prevStep', () => session.moveStep(-1));
  register('codeStories.showUnstoried', async () => {
    const files = session.unstoried;
    if (!files.length) {
      void vscode.window.showInformationMessage('Every changed file is part of a story.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      files.map(f => ({ label: f.path, description: f.missing ? MISSING_REASON : f.reason })),
      { title: 'Changes not in a story', placeHolder: store.doc?.unstoried?.summary ?? 'Pick a file to see its diff' }
    );
    if (pick) {
      await editor.openDiff(pick.label);
    }
  });
  register('codeStories.linkPr', () => comments.linkPr());
  register('codeStories.unlinkPr', () => comments.unlinkPr());
  register('codeStories.refreshPrComments', () => comments.refreshFromPr());
  register('codeStories.copyAgentPrompt', async () => {
    await vscode.env.clipboard.writeText(AGENT_PROMPT);
    void vscode.window.showInformationMessage(`Copied "${AGENT_PROMPT}". Paste it into your agent chat.`);
  });
  register('codeStories.comment.local', (reply: vscode.CommentReply) => comments.addLocal(reply));
  register('codeStories.comment.pr', (reply: vscode.CommentReply) => comments.addToPr(reply));
  register('codeStories.comment.prLink', (reply: vscode.CommentReply) => comments.addToPr(reply));
  register('codeStories.comment.reply', (reply: vscode.CommentReply) => comments.reply(reply));
  register('codeStories.comment.resolve', (thread: vscode.CommentThread) => comments.resolve(thread));
}

export function deactivate(): void {}

async function installSkill(context: vscode.ExtensionContext, folder?: vscode.WorkspaceFolder): Promise<void> {
  const targets = [
    ...(folder
      ? [
          { label: 'This workspace, for Claude Code', description: '.claude/skills', dir: path.join(folder.uri.fsPath, '.claude', 'skills') },
          { label: 'This workspace, for other agents', description: '.agents/skills', dir: path.join(folder.uri.fsPath, '.agents', 'skills') }
        ]
      : []),
    { label: 'All my projects, for Claude Code', description: '~/.claude/skills', dir: path.join(os.homedir(), '.claude', 'skills') }
  ];
  const pick = await vscode.window.showQuickPick(targets, { title: 'Install the code-stories agent skill' });
  if (!pick) {
    return;
  }
  const dest = path.join(pick.dir, SKILL_NAME);
  if (fs.existsSync(dest)) {
    const answer = await vscode.window.showWarningMessage(`${dest} already exists. Replace it?`, { modal: true }, 'Replace');
    if (answer !== 'Replace') {
      return;
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(path.join(context.extensionPath, 'skill', SKILL_NAME), dest, { recursive: true });
  void vscode.window.showInformationMessage(
    `Installed the skill to ${dest}. Ask your agent: "Create code stories for this branch".`
  );
}
