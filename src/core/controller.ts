import { Session } from './session';
import { reviewSummary } from './view';

/** What the panel can ask the editor to do. Each editor implements this with its own API. */
export interface Effects {
  /** Shows the working copy of a file against the base of the stories. */
  openDiff(file: string, line?: number): unknown;
  /** Opens a workspace file at a 1-based line. */
  openFile(file: string, line: number): unknown;
  copy(text: string): unknown;
  deleteSet(): unknown;
  installSkill(): unknown;
  linkPr(url?: string): unknown;
  unlinkPr(): unknown;
  refreshPr(): unknown;
  openComment(id: string): unknown;
}

/**
 * Handles one message from the story panel. Navigation changes the session, which tells the
 * editor to follow through its own events; everything else goes through `fx`.
 * Returns true when the message was one it knows.
 */
export async function handlePanelMessage(m: any, session: Session, fx: Effects): Promise<boolean> {
  switch (m?.type) {
    case 'selectSet':
      if (session.store.sets.some(s => s.id === m.id)) {
        session.selectSet(m.id);
      }
      return true;
    case 'deleteSet':
      await fx.deleteSet();
      return true;
    case 'openStory':
      session.openStory(m.index);
      return true;
    case 'overview':
      session.showOverview();
      return true;
    case 'step':
      session.selectStep(m.index, m.line);
      return true;
    case 'moveStep':
      session.moveStep(m.delta);
      return true;
    case 'toggleReviewed':
      session.toggleReviewed();
      return true;
    case 'openDiff': {
      const step = session.story?.steps[m.index];
      if (step) {
        await fx.openDiff(step.file, step.focusLine);
      }
      return true;
    }
    case 'openFile':
      session.selectStep(m.index);
      return true;
    case 'openUnstoried': {
      const file = session.unstoried.find(f => f.path === m.path);
      if (file) {
        await fx.openDiff(file.path);
      }
      return true;
    }
    case 'openLines':
      if (typeof m.path === 'string' && session.lineCoverage?.files.some(f => f.path === m.path)) {
        await fx.openDiff(m.path, Number(m.line) || undefined);
      }
      return true;
    case 'openTest': {
      const test = session.stories[m.story]?.tests[m.index];
      if (test) {
        await fx.openFile(test.file, test.line ?? 1);
      }
      return true;
    }
    case 'copySummary':
      await fx.copy(reviewSummary(session));
      return true;
    case 'copy':
      await fx.copy(String(m.text ?? ''));
      return true;
    case 'linkPr':
      await fx.linkPr(m.url);
      return true;
    case 'unlinkPr':
      await fx.unlinkPr();
      return true;
    case 'refreshPr':
      await fx.refreshPr();
      return true;
    case 'openComment':
      await fx.openComment(m.id);
      return true;
    case 'installSkill':
      await fx.installSkill();
      return true;
  }
  return false;
}
