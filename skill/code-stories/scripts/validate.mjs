#!/usr/bin/env node
// Checks one story set's stories.json against the working tree.
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
console.log(`Story set: ${set.id} (${path.relative(root, storiesPath).replace(/\\/g, '/')})`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(storiesPath, 'utf8'));
} catch (e) {
  console.error(`stories.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const fileCache = new Map();
function linesOf(file) {
  if (!fileCache.has(file)) {
    const abs = path.join(root, file);
    fileCache.set(file, fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : null);
  }
  return fileCache.get(file);
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
    storiedFiles.add(step.file.replace(/\\/g, '/'));
    const lines = linesOf(step.file);
    if (!lines) {
      errors.push(`${w}: file not found: ${step.file}`);
      continue;
    }
    if (!Number.isInteger(step.focusLine) || step.focusLine < 1 || step.focusLine > lines.length) {
      errors.push(`${w}: focusLine must be a line in ${step.file} (1 to ${lines.length})`);
    }
    if (!Array.isArray(step.lines) || step.lines.length === 0) {
      errors.push(`${w}: lines must be a non-empty array`);
      continue;
    }
    let previous = 0;
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
        continue;
      }
      if (!Number.isInteger(l.line) || l.line < 1 || l.line > lines.length) {
        errors.push(`${lw}: line ${l.line} is not in ${step.file} (1 to ${lines.length})`);
        continue;
      }
      if (l.line <= previous) errors.push(`${lw}: line numbers must increase (${l.line} after ${previous})`);
      previous = l.line;
      const actual = lines[l.line - 1].trim();
      if (actual !== l.text.trim()) {
        const found = lines.findIndex(x => x.trim() === l.text.trim());
        const hint = found >= 0 ? ` That text is on line ${found + 1}.` : '';
        errors.push(`${lw}: ${step.file}:${l.line} is "${actual}", not "${l.text.trim()}".${hint}`);
      }
    }
    const changedLines = step.lines.filter(l => l.kind === 'add' || l.kind === 'del').length;
    if (step.changed && changedLines === 0) errors.push(`${w}: changed is true but no line is add or del`);
    if (!step.changed && changedLines > 0) errors.push(`${w}: changed is false but it has add or del lines`);
    if (step.changed && !step.summary) warnings.push(`${w}: changed step has no summary`);
    const isLast = !story.steps.some(s => (s.calledFrom ? s.calledFrom === step.id : story.steps.indexOf(s) === i + 1));
    if (!isLast && !step.lines.some(l => l.kind === 'call')) {
      warnings.push(`${w}: no "call" line shows where it calls the next step`);
    }
    if (!step.sample) warnings.push(`${w}: no sample`);
    else if (!['test', 'generated'].includes(step.sample.source)) errors.push(`${w}: sample.source must be "test" or "generated"`);
    else if (step.sample.source === 'test' && !step.sample.test) warnings.push(`${w}: sample is from a test but does not name it`);
  }
}

const unstoried = new Set();
for (const [i, f] of (doc.unstoried?.files ?? []).entries()) {
  if (!f.path) errors.push(`unstoried.files[${i}]: path is required`);
  else unstoried.add(f.path.replace(/\\/g, '/'));
  if (!f.reason) errors.push(`unstoried.files[${i}]: reason is required. Say why ${f.path ?? 'the file'} is in no story`);
}

// Every changed file must be in a story or listed as unstoried.
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const base = doc.baseSha ?? doc.base;
if (base) {
  try {
    const prefix = git('rev-parse', '--show-prefix');
    // Untracked files are part of the change too: the panel flags them when they are left out.
    const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
    const tracked = git('diff', '--name-only', base)
      .split('\n')
      .filter(Boolean)
      .filter(f => f.startsWith(prefix))
      .map(f => f.slice(prefix.length));
    const changed = [...new Set([...tracked, ...untracked])].filter(f => !f.startsWith('.stories/'));
    for (const f of changed) {
      if (!storiedFiles.has(f) && !unstoried.has(f)) {
        errors.push(`${f} changed since ${doc.base ?? base} but is in no story and not in unstoried.files`);
      }
    }
    if (doc.headSha) {
      const head = git('rev-parse', 'HEAD');
      if (!head.startsWith(doc.headSha) && !doc.headSha.startsWith(head)) {
        warnings.push(`headSha is ${doc.headSha} but HEAD is ${head.slice(0, 12)}; update headSha`);
      }
    }
  } catch {
    warnings.push(`could not run git diff against "${base}", so changed-file coverage was not checked`);
  }
} else {
  warnings.push('no base or baseSha, so changed-file coverage was not checked');
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
const stories = Array.isArray(doc.stories) ? doc.stories.length : 0;
console.log(`${stories} ${stories === 1 ? 'story' : 'stories'}, ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
