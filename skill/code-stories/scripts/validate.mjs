#!/usr/bin/env node
// Checks one story set's stories.json against the working tree and the diff.
// Usage: node validate.mjs [workspace-root] [--set <name>]
// Without --set it checks the set that belongs to the current branch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SET, currentBranch, resolveSet, takeSetOption } from './sets.mjs';

const options = takeSetOption(process.argv.slice(2));
const root = path.resolve(options.rest[0] ?? '.');
const set = resolveSet(root, options.set);
const storiesPath = path.join(set.dir, 'stories.json');
const errors = [];
const warnings = [];
const KINDS = ['context', 'add', 'del', 'call'];
const MAX_GAP = 40;
/** Words that describe a value instead of giving it. */
const VAGUE = /^<.*>$|\.\.\.|…|\b(mock(ed)?|stub(bed)?|non-empty|placeholder|some (value|object|string|id|data)|any (value|object|string)|etc)\b/i;
console.log(`Story set: ${set.id} (${path.relative(root, storiesPath).replace(/\\/g, '/')})`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(storiesPath, 'utf8'));
} catch (e) {
  console.error(`stories.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

const fileCache = new Map();
function linesOf(file) {
  if (!fileCache.has(file)) {
    const abs = path.join(root, file);
    fileCache.set(file, fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : null);
  }
  return fileCache.get(file);
}

// The change itself: which files differ from the base, and which lines of each are new or modified.
// `changes` stays null when git cannot say, and every check that needs it is skipped with a warning.
const base = doc.baseSha ?? doc.base;
let changes = null;
if (base) {
  try {
    const prefix = git('rev-parse', '--show-prefix').trim();
    const added = new Map(); // file -> Map(line number -> text)
    let file = null;
    let inHunk = false;
    let n = 0;
    for (const line of git('diff', '-U0', '--relative', '--no-color', '--no-ext-diff', base).split('\n')) {
      if (line.startsWith('diff --git ')) {
        inHunk = false;
        file = null;
      } else if (!inHunk && line.startsWith('+++ ')) {
        file = line.startsWith('+++ b/') ? line.slice(6).replace(/\t$/, '') : null;
        if (file) added.set(file, added.get(file) ?? new Map());
      } else if (line.startsWith('@@')) {
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
        inHunk = !!m;
        n = m ? Number(m[1]) : 0;
      } else if (inHunk && file && line.startsWith('+')) {
        added.get(file).set(n++, line.slice(1));
      }
    }
    const tracked = git('diff', '--name-only', '--relative', base).split('\n').filter(Boolean);
    // Untracked files are part of the change too, and every line of them is new.
    const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
    for (const f of untracked) {
      const lines = linesOf(f);
      added.set(f, new Map((lines ?? []).map((text, i) => [i + 1, text])));
    }
    const files = [...new Set([...tracked, ...untracked])].filter(f => !f.startsWith('.stories/'));
    changes = { files, added, prefix };
    if (!files.length) {
      // Stories for a change that is already merged: there is no diff left to check them against.
      changes = null;
      warnings.push(`nothing differs from "${doc.base ?? base}", so the stories were not checked against the change`);
    }
  } catch {
    warnings.push(`could not run git diff against "${base}", so the stories were not checked against the change`);
  }
} else {
  warnings.push('no base or baseSha, so the stories were not checked against the change');
}

const baseCache = new Map();
/** Lines of a file as it was at the base, for code the change removed. */
function baseLinesOf(file) {
  if (!baseCache.has(file)) {
    let lines = null;
    try {
      lines = git('show', `${base}:./${file}`).split(/\r?\n/);
    } catch {
      // Not in the base either.
    }
    baseCache.set(file, lines);
  }
  return baseCache.get(file);
}

if (doc.version !== 1) errors.push('version: must be 1');
// The extension finds a branch's set by folder name or by head, so head must be the branch name.
const branch = currentBranch(root);
if (set.id !== DEFAULT_SET && branch && doc.head !== branch) {
  warnings.push(`head is "${doc.head ?? ''}" but the branch is "${branch}"; head must be the branch name`);
}
if (typeof doc.title !== 'string' || !doc.title) errors.push('title: required');
if (!Array.isArray(doc.stories) || doc.stories.length === 0) errors.push('stories: must be a non-empty array');

const storyIds = new Set();
const storiedFiles = new Set();
const testFiles = new Set(); // test files a story names: covered by its tests, not by steps
const shownLines = new Map(); // file -> Set of line numbers some step shows

for (const [si, story] of (Array.isArray(doc.stories) ? doc.stories : []).entries()) {
  const sw = `stories[${si}]${story.id ? ` (${story.id})` : ''}`;
  if (!story.id) errors.push(`${sw}: id is required`);
  else if (storyIds.has(story.id)) errors.push(`${sw}: duplicate story id`);
  storyIds.add(story.id);
  if (!story.title) errors.push(`${sw}: title is required`);
  if (!story.goal) errors.push(`${sw}: goal is required`);
  if (!story.entryPoint) warnings.push(`${sw}: no entryPoint`);
  if (!Array.isArray(story.steps) || story.steps.length === 0) {
    errors.push(`${sw}: steps must be a non-empty array`);
    continue;
  }
  if (!story.steps.some(s => s.changed)) warnings.push(`${sw}: no step is marked changed`);
  const ids = new Set(story.steps.map(s => s.id));

  // Tests that exercise the story, and the places the author wants looked at.
  if (story.tests !== undefined && !Array.isArray(story.tests)) errors.push(`${sw}: tests must be an array`);
  const tests = Array.isArray(story.tests) ? story.tests : [];
  if (!tests.length) warnings.push(`${sw}: no tests listed. Name the tests that cover this story, or leave it empty only if none exist`);
  for (const [ti, t] of tests.entries()) {
    const tw = `${sw}.tests[${ti}]`;
    if (!t || typeof t.name !== 'string' || !t.name) errors.push(`${tw}: name is required`);
    const lines = t && typeof t.file === 'string' ? linesOf(t.file) : null;
    if (lines) testFiles.add(t.file.replace(/\\/g, '/'));
    if (!lines) errors.push(`${tw}: file not found: ${t?.file ?? ''}. Never name a test that does not exist`);
    else if (t.line !== undefined && (!Number.isInteger(t.line) || t.line < 1 || t.line > lines.length)) errors.push(`${tw}: line ${t.line} is not in ${t.file}`);
    for (const id of Array.isArray(t?.steps) ? t.steps : []) {
      if (!ids.has(id)) errors.push(`${tw}: steps names "${id}", which is not a step id in this story`);
    }
  }
  if (story.risks !== undefined && !Array.isArray(story.risks)) errors.push(`${sw}: risks must be an array`);
  for (const [ri, r] of (Array.isArray(story.risks) ? story.risks : []).entries()) {
    const text = typeof r === 'string' ? r : r?.text;
    if (typeof text !== 'string' || !text) errors.push(`${sw}.risks[${ri}]: text is required`);
    if (r && typeof r === 'object' && r.step !== undefined && !ids.has(r.step)) {
      errors.push(`${sw}.risks[${ri}]: step "${r.step}" is not a step id in this story`);
    }
  }

  const stepIds = new Set();
  for (const [i, step] of story.steps.entries()) {
    const w = `${sw}.steps[${i}]${step.name ? ` (${step.name})` : ''}`;
    if (!step.id) errors.push(`${w}: id is required`);
    else if (stepIds.has(step.id)) errors.push(`${w}: duplicate step id`);
    stepIds.add(step.id);
    if (!step.name) errors.push(`${w}: name is required`);
    if (typeof step.changed !== 'boolean') errors.push(`${w}: changed must be true or false`);
    if (step.calledFrom && !story.steps.some(s => s.id === step.calledFrom)) {
      errors.push(`${w}: calledFrom "${step.calledFrom}" is not a step id in this story`);
    }
    if (!step.file) {
      errors.push(`${w}: file is required`);
      continue;
    }
    const file = step.file.replace(/\\/g, '/');
    storiedFiles.add(file);
    if (!Array.isArray(step.lines) || step.lines.length === 0) {
      errors.push(`${w}: lines must be a non-empty array`);
      continue;
    }
    if (!step.sample) warnings.push(`${w}: no sample`);
    else if (!['test', 'generated'].includes(step.sample.source)) errors.push(`${w}: sample.source must be "test" or "generated"`);
    else if (step.sample.source === 'test' && !step.sample.test) warnings.push(`${w}: sample is from a test but does not name it`);
    if (step.sample) checkSample(step.sample, w, step.lines.slice(0, 8).map(l => String(l.text ?? '')).join('\n'));
    let indent;
    let indentReported = false;
    /** The lines of a step must keep their indentation: each may lose the same amount, no more. */
    const checkIndent = (lw, where, actual, text) => {
      if (!text.trim() || indentReported) return;
      const lost = actual.trimEnd().length - text.trimEnd().length;
      if (indent === undefined) indent = lost;
      else if (lost !== indent) {
        indentReported = true;
        errors.push(`${lw}: the indentation of this step's lines is not kept (${where}). Copy every line with its leading whitespace, exactly as it is in the file`);
      }
    };

    // A removed function: every line is a del, read from the base version of the file.
    if (step.removed) {
      if (step.changed !== true) errors.push(`${w}: a removed step must have "changed": true`);
      const before = base ? baseLinesOf(file) : null;
      if (base && !before) errors.push(`${w}: ${file} is not in ${doc.base ?? base}, so there is no removed code to show`);
      let previous = 0;
      for (const [li, l] of step.lines.entries()) {
        const lw = `${w}.lines[${li}]`;
        if (l.kind !== 'del') errors.push(`${lw}: every line of a removed step must be "del"`);
        if (typeof l.text !== 'string') errors.push(`${lw}: text must be a string`);
        else if (!Number.isInteger(l.was)) errors.push(`${lw}: a line of a removed step needs "was", its line number in the base version`);
        else {
          if (l.was <= previous) errors.push(`${lw}: "was" numbers must increase (${l.was} after ${previous})`);
          previous = l.was;
          const actual = before?.[l.was - 1];
          if (before && (actual === undefined || actual.trim() !== l.text.trim())) {
            errors.push(`${lw}: ${file}:${l.was} at ${doc.base ?? base} is "${(actual ?? '').trim()}", not "${l.text.trim()}"`);
          } else if (before) {
            checkIndent(lw, `${file}:${l.was} at ${doc.base ?? base}`, actual, l.text);
          }
        }
      }
      continue;
    }

    const lines = linesOf(file);
    if (!lines) {
      errors.push(`${w}: file not found: ${step.file}. For code this change removed, set "removed": true`);
      continue;
    }
    if (!Number.isInteger(step.focusLine) || step.focusLine < 1 || step.focusLine > lines.length) {
      errors.push(`${w}: focusLine must be a line in ${step.file} (1 to ${lines.length})`);
    }
    const addedHere = changes?.added.get(file);
    const fileChanged = changes?.files.includes(file);
    const shown = shownLines.get(file) ?? new Set();
    shownLines.set(file, shown);
    let previous = 0;
    let opening = 0;
    for (const [li, l] of step.lines.entries()) {
      const lw = `${w}.lines[${li}]`;
      if (!KINDS.includes(l.kind)) {
        errors.push(`${lw}: kind must be one of ${KINDS.join(', ')}`);
        continue;
      }
      if (typeof l.text !== 'string') {
        errors.push(`${lw}: text must be a string`);
        continue;
      }
      if (l.kind === 'del') {
        if (l.line !== null && l.line !== undefined) errors.push(`${lw}: a del line must have "line": null`);
        if (!Number.isInteger(l.at)) warnings.push(`${lw}: a del line should set "at" to the current line it sat before`);
        if (changes && !fileChanged) errors.push(`${lw}: marked del, but ${file} did not change since ${doc.base ?? base}`);
        continue;
      }
      if (!Number.isInteger(l.line) || l.line < 1 || l.line > lines.length) {
        errors.push(`${lw}: line ${l.line} is not in ${step.file} (1 to ${lines.length})`);
        continue;
      }
      if (l.line <= previous) errors.push(`${lw}: line numbers must increase (${l.line} after ${previous})`);
      // A step is one function. A long jump inside the excerpt usually means it shows two.
      // The jump from the signature into a long function's body is expected, so it is not counted.
      if (previous > 0 && previous !== opening && l.line - previous > MAX_GAP) {
        warnings.push(`${w}: lines jump from ${previous} to ${l.line}. A step shows one function or block; split it if these are two`);
      }
      opening ||= l.line;
      previous = l.line;
      shown.add(l.line);
      const actual = lines[l.line - 1].trim();
      if (actual !== l.text.trim()) {
        const found = lines.findIndex(x => x.trim() === l.text.trim());
        const hint = found >= 0 ? ` That text is on line ${found + 1}.` : '';
        errors.push(`${lw}: ${step.file}:${l.line} is "${actual}", not "${l.text.trim()}".${hint}`);
        continue;
      }
      checkIndent(lw, `${step.file}:${l.line}`, lines[l.line - 1], l.text);
      // The kind must agree with the diff, so a changed line is never passed off as unchanged.
      if (changes) {
        const isNew = !!addedHere?.has(l.line);
        if (l.kind === 'add' && !isNew) {
          errors.push(`${lw}: ${step.file}:${l.line} is marked add, but it did not change since ${doc.base ?? base}. Mark it context`);
        } else if (l.kind !== 'add' && isNew && actual !== '') {
          const fix = l.kind === 'call' ? 'Mark it add with "calls": true' : 'Mark it add';
          errors.push(`${lw}: ${step.file}:${l.line} is marked ${l.kind}, but it is new or modified in this change. ${fix}`);
        }
      }
      if (l.calls !== undefined && (l.kind !== 'add' || typeof l.calls !== 'boolean')) {
        errors.push(`${lw}: "calls" is true or false, and only for an add line that makes the next call`);
      }
    }
    // A step opens with the signature of its function. Checked only when the step is named after
    // a function (Class.method, function); callbacks and top-level blocks carry free-form labels.
    if (/^[\w$]+(\.[\w$]+)*$/.test(step.name ?? '')) {
      const fn = step.name.split('.').pop();
      // The function's own comment may come first, so comment lines are not counted.
      const first = step.lines
        .filter(l => l.kind !== 'del' && typeof l.text === 'string' && !/^\s*(\/\/|\/\*|\*|#)/.test(l.text))
        .slice(0, 3);
      if (first.length && !first.some(l => new RegExp(`(^|[^\\w$])${fn.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(l.text))) {
        warnings.push(`${w}: the excerpt does not open with the signature of ${fn}. Show the signature line first`);
      }
    }
    const changedLines = step.lines.filter(l => l.kind === 'add' || l.kind === 'del').length;
    if (step.changed && changedLines === 0) errors.push(`${w}: changed is true but no line is add or del`);
    if (!step.changed && changedLines > 0) errors.push(`${w}: changed is false but it has add or del lines`);
    if (step.changed && !step.summary) warnings.push(`${w}: changed step has no summary`);
    const isLast = !story.steps.some(s => (s.calledFrom ? s.calledFrom === step.id : story.steps.indexOf(s) === i + 1));
    if (!isLast && !step.lines.some(l => l.kind === 'call' || l.calls === true)) {
      warnings.push(`${w}: no "call" line shows where it calls the next step`);
    }
  }
}

const unstoried = new Set();
for (const [i, f] of (doc.unstoried?.files ?? []).entries()) {
  if (!f.path) errors.push(`unstoried.files[${i}]: path is required`);
  else unstoried.add(f.path.replace(/\\/g, '/'));
  if (!f.reason) errors.push(`unstoried.files[${i}]: reason is required. Say why ${f.path ?? 'the file'} is in no story`);
}

/** Line numbers as short text: 64-74, 80. */
/** Every string in a JSON value, keys included. */
function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...stringsIn(v)]);
  return [];
}

/** A sample is JSON with actual values, so the reviewer sees real data, not a description of it. */
function checkSample(sample, w, signature) {
  for (const key of ['input', 'output']) {
    const text = sample[key];
    if (text === undefined || text === '') {
      warnings.push(`${w}: sample has no ${key}`);
      continue;
    }
    if (typeof text !== 'string') {
      errors.push(`${w}: sample.${key} must be a string that holds JSON`);
      continue;
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      errors.push(`${w}: sample.${key} is not JSON. Write the actual values as JSON, for example ${key === 'input' ? '{"code": "SPRING15", "subtotal": 120}' : '{"discount": 18}'}`);
      continue;
    }
    if (key === 'input' && (value === null || typeof value !== 'object')) {
      errors.push(`${w}: sample.input must be a JSON object: the arguments by parameter name, or the request`);
    }
    if (key === 'input' && value && typeof value === 'object' && !Array.isArray(value) && signature.includes('(')) {
      // The keys are the parameters. A key that the signature does not name was made up.
      const names = new Set(signature.match(/[A-Za-z_$][\w$]*/g) ?? []);
      const unknown = Object.keys(value).filter(k => !names.has(k) && k !== 'this' && k !== 'self');
      if (unknown.length) {
        warnings.push(`${w}: sample.input has ${unknown.map(k => `"${k}"`).join(', ')}, which the function's signature does not name. Use one key for each parameter, named as the parameter`);
      }
    }
    const vague = stringsIn(value).find(s => VAGUE.test(s));
    if (vague !== undefined) {
      warnings.push(`${w}: sample.${key} has "${vague}", which reads as a description. Write the actual value`);
    }
    if (text.length > 60 && !text.includes('\n')) {
      warnings.push(`${w}: sample.${key} is one long line. Format it with two-space indentation (JSON.stringify(value, null, 2))`);
    }
  }
}

function ranges(numbers) {
  const parts = [];
  let start = numbers[0];
  let end = numbers[0];
  for (const n of [...numbers.slice(1), NaN]) {
    if (n === end + 1) {
      end = n;
      continue;
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    start = end = n;
  }
  return parts.slice(0, 8).join(', ') + (parts.length > 8 ? ', ...' : '');
}

if (changes) {
  // Every changed file must be in a story or listed as unstoried.
  for (const f of changes.files) {
    if (!storiedFiles.has(f) && !testFiles.has(f) && !unstoried.has(f)) {
      errors.push(`${f} changed since ${doc.base ?? base} but is in no story and not in unstoried.files`);
    }
  }
  // Every changed line of a storied file should be in a step. The panel lists the ones that are not
  // under "Lines not seen", so the reviewer still finds them, but they are outside every story.
  let total = 0;
  let seen = 0;
  for (const f of changes.files.filter(x => storiedFiles.has(x))) {
    const added = [...(changes.added.get(f) ?? [])].filter(([, text]) => text.trim()).map(([n]) => n);
    const shown = shownLines.get(f) ?? new Set();
    const hidden = added.filter(n => !shown.has(n));
    total += added.length;
    seen += added.length - hidden.length;
    if (hidden.length) {
      warnings.push(`${f}: ${hidden.length} changed line(s) are in no step (${ranges(hidden)}). Show them in a step, or add a step or story for them`);
    }
  }
  console.log(`Changed lines in storied files: ${seen} of ${total} are shown in a step`);
  if (doc.headSha) {
    try {
      const head = git('rev-parse', 'HEAD').trim();
      if (!head.startsWith(doc.headSha) && !doc.headSha.startsWith(head)) {
        warnings.push(`headSha is ${doc.headSha} but HEAD is ${head.slice(0, 12)}; update headSha`);
      }
    } catch {
      // Not a repository with commits.
    }
  }
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
const stories = Array.isArray(doc.stories) ? doc.stories.length : 0;
console.log(`${stories} ${stories === 1 ? 'story' : 'stories'}, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
