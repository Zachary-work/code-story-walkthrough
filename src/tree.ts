import * as vscode from 'vscode';
import { Story } from './model';
import { Session } from './session';

type Node = { story: Story; index: number } | 'unstoried';

/** The story list in the activity bar. */
export class StoryTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: Session) {
    this.subscription = session.onDidChange(() => this.emitter.fire());
  }

  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    const nodes: Node[] = this.session.stories.map((story, index) => ({ story, index }));
    if (this.session.store.doc?.unstoried?.files?.length) {
      nodes.push('unstoried');
    }
    return nodes;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node === 'unstoried') {
      const files = this.session.store.doc!.unstoried!.files.length;
      const item = new vscode.TreeItem('Not in a story');
      item.description = `${files} file${files === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command: 'codeStories.showUnstoried', title: 'View diffs' };
      return item;
    }
    const { story, index } = node;
    const reviewed = this.session.isReviewed(story);
    const changed = story.steps.filter(s => s.changed).length;
    const item = new vscode.TreeItem(`${index + 1}. ${story.title}`);
    item.description = `${reviewed ? 'Reviewed · ' : ''}${story.steps.length} methods, ${changed} changed`;
    item.tooltip = story.goal;
    item.iconPath = new vscode.ThemeIcon(reviewed ? 'pass-filled' : 'circle-large-outline');
    item.command = { command: 'codeStories.openStory', title: 'Open story', arguments: [index] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
