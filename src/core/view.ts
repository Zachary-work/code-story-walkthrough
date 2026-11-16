import * as path from 'path';
import { statusLabel } from './model';
import { Session } from './session';

export const AGENT_PROMPT = '/code-stories read and address my review comments';
export const CREATE_PROMPT = '/code-stories create stories for this branch';
export const REFRESH_PROMPT = '/code-stories refresh the stories so every changed line is covered';
export const MISSING_REASON = 'Missing from the stories file';

/** Everything the story panel draws. The same object goes to the panel in every editor. */
export function panelState(session: Session) {
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

/** Where the review stands, as plain text to paste into a pull request or a chat. */
export function reviewSummary(session: Session): string {
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
    out.push('', `Changed lines: ${lines.total} in all. Shown in a story: ${lines.shown}. In the stories' tests: ${lines.tests}. In files left out with a reason: ${lines.leftOut}. Shown nowhere: ${lines.unseen}.`);
  }
  if (session.staleSteps) {
    out.push(`Out of date: ${session.staleSteps} step${session.staleSteps === 1 ? ' no longer matches' : 's no longer match'} the code`);
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

/** Line numbers as short text: 64 to 74, 80. */
export function ranges(lines: number[]): string {
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
