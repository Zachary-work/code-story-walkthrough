import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommentUi } from './comments';
import { EditorFollower } from './editor';
import { CommentBook } from './core/comments';
import { Session } from './core/session';
import { DEFAULT_SET, Store, setIdFor } from './core/store';
import { AGENT_PROMPT, MISSING_REASON } from './core/view';
import { StoryPanel } from './panel';
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

  // The shared core watches nothing itself. These are the events it needs from VS Code.
  const openText = (fsPath: string) => vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === fsPath)?.getText();
  const store = new Store(folder.uri.fsPath);
  const session = new Session(store, { memento: context.workspaceState, openText });
  const stories = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.stories/**/*.json'));
  stories.onDidChange(() => store.reloadSoon());
  stories.onDidCreate(() => store.reloadSoon());
  stories.onDidDelete(() => store.reloadSoon());
  // .git/HEAD changes on a branch switch. Window focus covers worktrees, where .git is a file.
  const head = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/HEAD'));
  head.onDidChange(() => void session.checkGit());
  context.subscriptions.push(
    stories,
    head,
    vscode.workspace.onDidSaveTextDocument(() => void session.checkGit()),
    vscode.window.onDidChangeWindowState(state => state.focused && void session.checkGit())
  );

  const deleteSet = () => vscode.commands.executeCommand('codeStories.deleteSet');
  const editor = new EditorFollower(session);
  const comments = new CommentUi(store, new CommentBook(store, openText), editor);
  const panel = new StoryPanel(context.extensionUri, session, comments, editor, deleteSet);
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

  // Opening a set's stories.json brings up the panel beside it, showing that set.
  const showForStoriesFile = (active?: vscode.TextEditor) => {
    const rel = active?.document.uri.scheme === 'file' ? store.rel(active.document.uri.fsPath) : undefined;
    const match = rel && /^\.stories\/(?:([^/]+)\/)?stories\.json$/.exec(rel);
    if (match) {
      const setId = match[1] ?? DEFAULT_SET;
      if (setId !== store.setId) {
        session.selectSet(setId);
      }
      panel.show(true);
    }
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(showForStoriesFile));
  showForStoriesFile(vscode.window.activeTextEditor);
  register('codeStories.switchSet', async () => {
    if (!store.sets.length) {
      void vscode.window.showInformationMessage('There are no story sets in this workspace yet.');
      return;
    }
    const own = session.branch ? setIdFor(session.branch) : undefined;
    const pick = await vscode.window.showQuickPick(
      store.sets.map(s => ({
        label: s.title,
        description: [s.id, s.id === store.setId ? 'showing' : '', s.id === own || s.head === session.branch ? 'this branch' : '']
          .filter(Boolean)
          .join(' · '),
        id: s.id
      })),
      { title: 'Story sets', placeHolder: 'Each set is the stories and comments of one change' }
    );
    if (pick) {
      session.selectSet(pick.id);
      panel.show();
    }
  });
  register('codeStories.deleteSet', async () => {
    const set = store.sets.find(s => s.id === store.setId);
    if (!set) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete the story set "${set.title}"?`,
      { modal: true, detail: `This moves ${store.rel(store.dirOf(set.id))} (its stories and review comments) to the trash.` },
      'Delete'
    );
    if (answer === 'Delete') {
      for (const target of store.deleteTargets(set.id)) {
        await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
      }
      store.reload();
    }
  });
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
