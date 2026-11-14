// File formats shared with the agent skill. See skill/code-stories/references/schema.md.

export type LineKind = 'context' | 'add' | 'del' | 'call';

export interface StoryLine {
  /** 1-based line in the current file. null for a deleted line. */
  line: number | null;
  /** For a deleted line: the current line it sat just before. */
  at?: number;
  kind: LineKind;
  text: string;
}

export interface Sample {
  source: 'test' | 'generated';
  test?: string;
  input?: string;
  output?: string;
  note?: string;
}

export interface Step {
  id: string;
  name: string;
  participant: string;
  call: string;
  /** Index of the calling step in the story, -1 for the entry point. */
  caller: number;
  file: string;
  focusLine: number;
  changed: boolean;
  additions: number;
  deletions: number;
  summary?: string;
  lines: StoryLine[];
  sample?: Sample;
}

export interface Story {
  id: string;
  title: string;
  goal: string;
  entryPoint?: string;
  steps: Step[];
}

export interface StoriesDoc {
  version: number;
  title: string;
  base?: string;
  head?: string;
  baseSha?: string;
  headSha?: string;
  stats?: { files: number; additions: number; deletions: number };
  stories: Story[];
  unstoried?: { summary?: string; files: { path: string; reason?: string }[] };
}

export type CommentStatus = 'waiting' | 'changed' | 'declined' | 'answered' | 'posted';

export interface Message {
  /** "you", "agent", or a display name such as a GitHub login. */
  author: string;
  at: string;
  text: string;
  githubId?: number;
}

export interface ReviewComment {
  id: string;
  source: 'local' | 'pr';
  file: string;
  startLine: number;
  endLine: number;
  /** Trimmed text of endLine when the comment was made, used to re-anchor after edits. */
  text?: string;
  status: CommentStatus;
  resolved?: boolean;
  messages: Message[];
  github?: { id: number; url?: string };
}

export interface PrLink {
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export interface CommentsFile {
  version: number;
  pr?: PrLink | null;
  comments: ReviewComment[];
}

const KINDS: LineKind[] = ['context', 'add', 'del', 'call'];

function fail(where: string, what: string): never {
  throw new Error(`${where}: ${what}`);
}

function str(v: unknown, where: string, field: string): string {
  if (typeof v !== 'string' || v === '') {
    fail(where, `"${field}" must be a non-empty string`);
  }
  return v;
}

/** Parses and normalises stories.json. Throws with a message that names the bad field. */
export function parseStories(raw: string): StoriesDoc {
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.stories)) {
    fail('stories.json', '"stories" must be an array');
  }
  doc.title = typeof doc.title === 'string' ? doc.title : 'Untitled change';
  doc.stories.forEach((story: any, si: number) => {
    const sw = `stories[${si}]`;
    story.id = typeof story.id === 'string' ? story.id : `story-${si + 1}`;
    str(story.title, sw, 'title');
    story.goal = typeof story.goal === 'string' ? story.goal : '';
    if (!Array.isArray(story.steps) || story.steps.length === 0) {
      fail(sw, '"steps" must be a non-empty array');
    }
    story.steps.forEach((step: any, i: number) => {
      const w = `${sw}.steps[${i}]`;
      step.id = typeof step.id === 'string' ? step.id : `s${i + 1}`;
      str(step.name, w, 'name');
      str(step.file, w, 'file');
      step.file = step.file.replace(/\\/g, '/');
      const dot = step.name.lastIndexOf('.');
      step.participant = step.participant || (dot > 0 ? step.name.slice(0, dot) : step.name);
      step.call = step.call || `${dot > 0 ? step.name.slice(dot + 1) : step.name}()`;
      if (!Array.isArray(step.lines)) {
        fail(w, '"lines" must be an array');
      }
      step.lines.forEach((l: any, li: number) => {
        const lw = `${w}.lines[${li}]`;
        if (!KINDS.includes(l.kind)) {
          fail(lw, `"kind" must be one of ${KINDS.join(', ')}`);
        }
        if (typeof l.text !== 'string') {
          fail(lw, '"text" must be a string');
        }
        if (l.kind === 'del') {
          l.line = null;
        } else if (!Number.isInteger(l.line) || l.line < 1) {
          fail(lw, '"line" must be a positive integer');
        }
      });
      const adds = step.lines.filter((l: StoryLine) => l.kind === 'add').length;
      const dels = step.lines.filter((l: StoryLine) => l.kind === 'del').length;
      step.changed = typeof step.changed === 'boolean' ? step.changed : adds + dels > 0;
      step.additions = Number.isInteger(step.additions) ? step.additions : adds;
      step.deletions = Number.isInteger(step.deletions) ? step.deletions : dels;
      const firstNumbered = step.lines.find((l: StoryLine) => l.line !== null);
      step.focusLine = Number.isInteger(step.focusLine) ? step.focusLine : firstNumbered?.line ?? 1;
    });
    story.steps.forEach((step: any, i: number) => {
      const from = story.steps.findIndex((s: Step) => s.id === step.calledFrom);
      step.caller = step.calledFrom && from >= 0 && from !== i ? from : i - 1;
    });
  });
  return doc as StoriesDoc;
}

export function parseComments(raw: string): CommentsFile {
  const file = JSON.parse(raw);
  if (!file || typeof file !== 'object') {
    throw new Error('comments.json: must be an object');
  }
  file.version = file.version ?? 1;
  file.comments = Array.isArray(file.comments) ? file.comments : [];
  for (const c of file.comments) {
    c.messages = Array.isArray(c.messages) ? c.messages : [];
    c.endLine = c.endLine ?? c.startLine;
  }
  return file as CommentsFile;
}

/**
 * Finds where a recorded line now sits. Returns `line` when its text still matches,
 * otherwise the nearest line with the same trimmed text, otherwise `line` unchanged.
 */
export function resolveLine(lineAt: (n: number) => string | undefined, line: number, text?: string): number {
  const want = text?.trim();
  if (!want) {
    return line;
  }
  for (let d = 0; d <= 60; d++) {
    for (const n of d === 0 ? [line] : [line + d, line - d]) {
      if (n >= 1 && lineAt(n)?.trim() === want) {
        return n;
      }
    }
  }
  return line;
}

export function statusLabel(c: ReviewComment, prNumber?: number): string {
  switch (c.status) {
    case 'changed':
      return 'Changed by agent';
    case 'declined':
      return 'Declined by agent';
    case 'answered':
      return 'Answered by agent';
    case 'posted':
      return prNumber ? `Posted to PR #${prNumber}` : 'Posted to PR';
    default:
      return 'Waiting for agent';
  }
}

export function authorName(author: string): string {
  if (author === 'you') {
    return 'You';
  }
  return author === 'agent' ? 'Agent' : author;
}

export function rangeText(from: number, to: number): string {
  return from === to ? `line ${to}` : `lines ${from} to ${to}`;
}
