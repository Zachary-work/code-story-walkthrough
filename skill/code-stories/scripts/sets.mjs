#!/usr/bin/env node
// Story sets: each change has its own folder in .stories/, normally named after the branch.
// Usage (from the workspace root):
//   node sets.mjs list          the sets that exist, and which one belongs to the current branch
//   node sets.mjs path [name]   the folder to write to: for the current branch, or for a name you give
// Also imported by validate.mjs and comments.mjs to find the set they work on.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The set made of .stories/stories.json itself, from before each change had its own folder. */
export const DEFAULT_SET = 'default';

/** Folder name for a branch or a name: feature/promo-codes becomes feature-promo-codes. */
export function slug(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || DEFAULT_SET;
}

function git(root, ...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function currentBranch(root) {
  return git(root, 'branch', '--show-current');
}

/** True for the branch everything is merged into, where unrelated changes can follow each other. */
export function isDefaultBranch(root, branch) {
  const remote = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '');
  return branch !== '' && (branch === remote || ['main', 'master', 'trunk'].includes(branch));
}

export function dirOf(root, id) {
  const base = path.join(root, '.stories');
  return id === DEFAULT_SET ? base : path.join(base, id);
}

export function listSets(root) {
  const base = path.join(root, '.stories');
  if (!fs.existsSync(base)) {
    return [];
  }
  const names = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory() && e.name !== DEFAULT_SET).map(e => e.name);
  const sets = [];
  for (const id of [DEFAULT_SET, ...names.sort()]) {
    const file = path.join(dirOf(root, id), 'stories.json');
    if (!fs.existsSync(file)) {
      continue;
    }
    const set = { id, dir: dirOf(root, id), title: id, head: undefined, stories: 0, files: [], modified: fs.statSync(file).mtime };
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      set.title = doc.title || id;
      set.head = doc.head;
      set.stories = Array.isArray(doc.stories) ? doc.stories.length : 0;
      set.files = [...new Set((doc.stories ?? []).flatMap(s => (s.steps ?? []).map(step => step.file)))];
    } catch {
      set.title = `${id} (stories.json is not valid JSON)`;
    }
    sets.push(set);
  }
  return sets;
}

/**
 * The set a script should work on. With a name, that set. Otherwise the same choice the extension
 * makes: the set named after the branch, else the newest set written on this branch, else the
 * default set, else the only set there is. Exits with the list when it cannot tell.
 */
export function resolveSet(root, name) {
  const sets = listSets(root);
  const fail = message => {
    console.error(message);
    for (const s of sets) console.error(`  ${s.id}  "${s.title}"${s.head ? `  written on ${s.head}` : ''}`);
    process.exit(1);
  };
  if (name) {
    return sets.find(s => s.id === name || s.id === slug(name)) ?? fail(`There is no story set "${name}". Sets:`);
  }
  if (!sets.length) {
    fail('There are no story sets in .stories/ yet.');
  }
  const branch = currentBranch(root);
  const onBranch = sets.filter(s => branch && s.head === branch).sort((a, b) => b.modified - a.modified)[0];
  return (
    sets.find(s => branch && s.id === slug(branch)) ??
    onBranch ??
    sets.find(s => s.id === DEFAULT_SET) ??
    (sets.length === 1 ? sets[0] : fail(`No story set belongs to branch "${branch}". Pass --set <name>. Sets:`))
  );
}

/** Splits "--set <name>" out of an argument list. */
export function takeSetOption(args) {
  const i = args.indexOf('--set');
  if (i < 0) {
    return { rest: args, set: undefined };
  }
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], set: args[i + 1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const [command = 'list', name] = process.argv.slice(2);
  const branch = currentBranch(root);
  const rel = dir => path.relative(root, dir).replace(/\\/g, '/');
  if (command === 'path') {
    console.log(rel(dirOf(root, slug(name ?? branch))));
  } else if (command === 'list') {
    const sets = listSets(root);
    const own = branch ? slug(branch) : '';
    console.log(`Branch: ${branch || '(detached HEAD)'}${isDefaultBranch(root, branch) ? '  (the default branch: name the set after the change, not the branch)' : ''}`);
    if (!sets.length) {
      console.log('No story sets yet.');
    }
    for (const s of sets) {
      const mark = s.id === own ? '  <- the set for this branch' : s.head === branch && branch ? '  <- written on this branch' : '';
      console.log(`\n${s.id}${mark}\n  title: ${s.title}\n  folder: ${rel(s.dir)}\n  written on: ${s.head ?? 'unknown'}, ${s.modified.toISOString().slice(0, 16).replace('T', ' ')}\n  ${s.stories} stories over: ${s.files.join(', ') || 'no files'}`);
    }
    if (branch && !isDefaultBranch(root, branch) && !sets.some(s => s.id === own)) {
      console.log(`\nA new set for this branch goes in ${rel(dirOf(root, own))}`);
    }
  } else {
    console.error('Usage: node sets.mjs list | path [name]');
    process.exit(1);
  }
}
