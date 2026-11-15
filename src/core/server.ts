// The shared core as a background process, for editors that cannot load it directly (IntelliJ).
// It reads one JSON message per line on stdin and writes one per line on stdout.
//
//   node server.js --root <workspace> --state <file for reviewed marks> [--skill <skill folder>]
//
// In:  { type: 'panel', message }           a message from the story panel, as the panel sends it
//      { type: 'event', name }              'saved' | 'focus': something may have changed on disk
//      { type: 'command', name, ... }       nextStep, prevStep, selectSet, deleteSet, installSkill, linkPr
//      { type: 'comment', op, ... }         add, reply, resolve
// Out: { type: 'state', state }             what the panel draws
//      { type: 'navigate', ... }            the editor should show this file and line
//      { type: 'decorate', files }          lines to mark in open editors
//      { type: 'comments', threads }        review threads to draw in the gutter
//      { type: 'effect', name, ... }        openDiff, openFile, copy, confirmDeleteSet, askInstallSkill, askLinkPr, message
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { CommentBook } from './comments';
import { handlePanelMessage } from './controller';
import { authorName, rangeText, resolveLine, statusLabel } from './model';
import { Session } from './session';
import { Store } from './store';
import { panelState } from './view';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = path.resolve(arg('root') ?? '.');
const statePath = arg('state');
const skillDir = arg('skill');

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function say(level: 'info' | 'warning' | 'error', text: string): void {
  send({ type: 'effect', name: 'message', level, text });
}

// --- reviewed marks, kept in a file the editor chooses ----------------------------------------------

let saved: Record<string, unknown> = {};
try {
  saved = statePath ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
} catch {
  // First run, or an unreadable file: start empty.
}
const memento = {
  get: <T>(key: string, fallback: T): T => (key in saved ? (saved[key] as T) : fallback),
  update: (key: string, value: unknown): void => {
    saved[key] = value;
    if (statePath) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(saved));
    }
  }
};

const store = new Store(root);
const session = new Session(store, { memento });
const book = new CommentBook(store);

// --- what goes out ----------------------------------------------------------------------------------

function fileLines(file: string): string[] {
  try {
    return fs.readFileSync(store.abs(file), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function baseOf(): string | undefined {
  return store.doc?.baseSha ?? store.doc?.base;
}

/** A file as it was at the base of the stories, or null when it did not exist there. */
function baseText(file: string): Promise<string | null> {
  const base = baseOf();
  return new Promise(resolve => {
    if (!base) {
      return resolve(null);
    }
    execFile('git', ['show', `${base}:./${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout)
    );
  });
}

/** Lines of the open story to mark in the editor: added lines, and the lines that call the next step. */
function decorations(): Record<string, { line: number; kind: 'add' | 'call'; hint?: string }[]> {
  const out: Record<string, { line: number; kind: 'add' | 'call'; hint?: string }[]> = {};
  const story = session.view === 'story' ? session.story : undefined;
  story?.steps.forEach((step, index) => {
    if (step.removed) {
      return;
    }
    const lines = fileLines(step.file);
    const calleeIndex = story.steps.findIndex(s => s.caller === index);
    const callee = story.steps[calleeIndex];
    const hint = callee ? `→ calls step ${calleeIndex + 1}${callee.changed ? ', changed' : ''}` : undefined;
    for (const l of step.lines) {
      if (l.line === null || l.kind === 'context') {
        continue;
      }
      const line = resolveLine(n => lines[n - 1], l.line, l.text);
      const list = (out[step.file] ??= []);
      if (l.kind === 'add') {
        list.push({ line, kind: 'add' });
      }
      if (l.kind === 'call' || l.calls) {
        list.push({ line, kind: 'call', hint });
      }
    }
  });
  return out;
}

function threads() {
  const pr = book.pr;
  return store.comments.comments
    .filter(c => !c.resolved && c.file && c.id)
    .map(c => {
      const at = book.anchor(c);
      const destination = c.source === 'local' ? 'Local, for your agent' : `On PR #${pr?.number ?? ''}`.trim();
      return {
        id: c.id,
        file: c.file,
        startLine: at.startLine,
        endLine: at.endLine,
        source: c.source,
        status: c.status,
        label: `${statusLabel(c, pr?.number)} · ${destination}, ${rangeText(c.startLine, c.endLine)}`,
        messages: c.messages.map(m => ({ author: authorName(m.author), at: m.at, text: m.text }))
      };
    });
}

let pending = false;
function publish(): void {
  if (pending) {
    return;
  }
  pending = true;
  setImmediate(() => {
    pending = false;
    send({ type: 'state', state: panelState(session) });
    send({ type: 'decorate', files: decorations() });
    send({ type: 'comments', threads: threads(), prLinked: !!book.pr });
  });
}

session.onDidChange(publish);
store.onDidChange(publish);
session.onDidNavigate(() => {
  const step = session.step;
  if (!step) {
    return;
  }
  const wanted = session.line || step.focusLine;
  if (step.removed) {
    void baseText(step.file).then(text => send({ type: 'navigate', file: step.file, line: wanted, removed: true, baseText: text, base: store.doc?.base ?? '' }));
    return;
  }
  const text = step.lines.find(l => l.line === wanted)?.text;
  send({ type: 'navigate', file: step.file, line: resolveLine(n => fileLines(step.file)[n - 1], wanted, text) });
});

// --- what the panel can ask for ---------------------------------------------------------------------

const effects = {
  openDiff: async (file: string, line?: number) => {
    const exists = fs.existsSync(store.abs(file));
    send({ type: 'effect', name: 'openDiff', file, line: line ?? 1, exists, baseText: await baseText(file), base: store.doc?.base ?? baseOf()?.slice(0, 7) ?? '' });
  },
  openFile: (file: string, line: number) => send({ type: 'effect', name: 'openFile', file, line }),
  copy: (text: string) => send({ type: 'effect', name: 'copy', text }),
  deleteSet: () => {
    const set = store.sets.find(s => s.id === store.setId);
    if (set) {
      send({ type: 'effect', name: 'confirmDeleteSet', id: set.id, title: set.title, folder: store.rel(store.dirOf(set.id)) ?? '.stories' });
    }
  },
  installSkill: () => send({ type: 'effect', name: 'askInstallSkill' }),
  linkPr: (url?: string) => {
    if (url === undefined) {
      send({ type: 'effect', name: 'askLinkPr' });
    } else if (!book.linkPr(url)) {
      say('warning', 'That is not a pull request link. Use one like https://github.com/owner/repo/pull/123.');
    }
  },
  unlinkPr: () => book.unlinkPr(),
  refreshPr: async () => {
    const pr = book.pr;
    if (!pr) {
      return say('info', 'No pull request is linked.');
    }
    try {
      const added = await book.refreshFromPr();
      say('info', added ? `Added ${added} repl${added === 1 ? 'y' : 'ies'} from PR #${pr.number}.` : 'No new replies.');
    } catch (e) {
      say('error', `Could not read PR #${pr.number}. ${(e as Error).message}`);
    }
  },
  openComment: (id: string) => {
    const c = book.find(id);
    if (c) {
      const at = book.anchor(c);
      send({ type: 'effect', name: 'openComment', id, file: c.file, startLine: at.startLine, endLine: at.endLine });
    }
  }
};

async function comment(m: any): Promise<void> {
  try {
    if (m.op === 'add') {
      const source = m.source === 'pr' ? 'pr' : 'local';
      const draft = book.draft(String(m.file), Number(m.startLine), Number(m.endLine), String(m.body ?? ''), source);
      if (!draft) {
        return;
      }
      if (source === 'pr') {
        const pr = book.pr;
        if (!pr) {
          return say('warning', 'Link a pull request first, then comment on it.');
        }
        await book.postToPr(draft, pr);
      }
      book.save(draft);
    } else if (m.op === 'reply') {
      await book.reply(String(m.id), String(m.body ?? ''));
    } else if (m.op === 'resolve') {
      book.resolve(String(m.id));
    }
  } catch (e) {
    say('error', `Could not save the comment. ${(e as Error).message} For a pull request comment, the lines must be part of its diff and pushed.`);
  }
}

function installSkill(where: string): void {
  if (!skillDir || !fs.existsSync(skillDir)) {
    return say('error', 'The skill files are missing from this plugin.');
  }
  const base = where === 'home' ? path.join(os.homedir(), '.claude', 'skills') : path.join(root, where === 'agents' ? '.agents' : '.claude', 'skills');
  const dest = path.join(base, 'code-stories');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(skillDir, dest, { recursive: true });
  say('info', `Installed the skill to ${dest}. Ask your agent: "Create code stories for this branch".`);
}

async function command(m: any): Promise<void> {
  switch (m.name) {
    case 'nextStep':
      return session.moveStep(1);
    case 'prevStep':
      return session.moveStep(-1);
    case 'selectSet':
      return session.selectSet(String(m.id));
    case 'deleteSet':
      for (const target of store.deleteTargets(String(m.id))) {
        fs.rmSync(target, { recursive: true, force: true });
      }
      return store.reload();
    case 'installSkill':
      return installSkill(String(m.where));
    case 'linkPr':
      return void effects.linkPr(String(m.url ?? ''));
  }
}

// --- watching ---------------------------------------------------------------------------------------

function watch(target: string, options: fs.WatchOptions, onChange: (file: string | null) => void): void {
  let watcher: fs.FSWatcher | undefined;
  const start = () => {
    if (watcher || !fs.existsSync(target)) {
      return;
    }
    try {
      watcher = fs.watch(target, options, (_event, file) => onChange(file ? String(file) : null));
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };
  start();
  // .stories/ may not exist yet when the editor opens; look again now and then.
  setInterval(start, 3000).unref();
}

watch(path.join(root, '.stories'), { recursive: true }, file => {
  if (!file || file.endsWith('.json')) {
    store.reloadSoon();
  }
});
// .git/HEAD changes on a branch switch.
watch(path.join(root, '.git'), {}, file => {
  if (file === 'HEAD') {
    void session.checkGit();
  }
});

readline.createInterface({ input: process.stdin }).on('line', line => {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const done = (p: unknown) => Promise.resolve(p).catch(e => say('error', (e as Error).message));
  if (m.type === 'panel') {
    if (m.message?.type === 'ready') {
      // The panel was opened (again): it gets the stories, and .stories/ is read afresh in case it just appeared.
      store.reload();
      publish();
    } else {
      void done(handlePanelMessage(m.message, session, effects));
    }
  } else if (m.type === 'event') {
    void done(session.checkGit());
  } else if (m.type === 'command') {
    void done(command(m));
  } else if (m.type === 'comment') {
    void done(comment(m));
  }
});
process.stdin.on('end', () => process.exit(0));

send({ type: 'hello', root, version: 1 });
publish();
