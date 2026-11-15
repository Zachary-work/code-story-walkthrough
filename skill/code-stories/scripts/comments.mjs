#!/usr/bin/env node
// Lists the reviewer's waiting comments and records the agent's replies.
// Usage (from the workspace root):
//   node comments.mjs list
//   node comments.mjs reply <id> <changed|declined|answered> "<text>"   (text "-" reads stdin)
// Add --set <name> to work on a set other than the current branch's.
import fs from 'node:fs';
import path from 'node:path';
import { resolveSet, takeSetOption } from './sets.mjs';

const root = process.cwd();
const options = takeSetOption(process.argv.slice(2));
const set = resolveSet(root, options.set);
const file = path.join(set.dir, 'comments.json');
const [command, ...args] = options.rest;

function load() {
  if (!fs.existsSync(file)) {
    return { version: 1, comments: [] };
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isWaiting(c) {
  return c.source === 'local' && !c.resolved && c.status === 'waiting';
}

// Where the commented lines are now: they may have moved since the comment was made.
function locate(c) {
  const abs = path.join(root, c.file);
  if (!fs.existsSync(abs)) {
    return { lines: null };
  }
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  let end = c.endLine;
  const want = c.text?.trim();
  if (want && lines[end - 1]?.trim() !== want) {
    for (let d = 1; d <= 200; d++) {
      const hit = [end + d, end - d].find(n => lines[n - 1]?.trim() === want);
      if (hit) {
        end = hit;
        break;
      }
    }
  }
  const start = Math.max(1, c.startLine + (end - c.endLine));
  return { lines, start, end, moved: end !== c.endLine };
}

if (command === 'list') {
  const waiting = load().comments.filter(isWaiting);
  if (!waiting.length) {
    console.log(`No local comments are waiting in story set "${set.id}".`);
    process.exit(0);
  }
  for (const c of waiting) {
    const at = locate(c);
    console.log(`=== ${c.id}  ${c.file}:${at.lines ? (at.start === at.end ? at.end : `${at.start}-${at.end}`) : c.endLine}${at.moved ? `  (moved from ${c.startLine}-${c.endLine})` : ''}`);
    if (!at.lines) {
      console.log('  (file no longer exists)');
    } else {
      for (let n = Math.max(1, at.start - 2); n <= Math.min(at.lines.length, at.end + 2); n++) {
        console.log(`${n >= at.start && n <= at.end ? '>' : ' '} ${String(n).padStart(4)}  ${at.lines[n - 1]}`);
      }
    }
    for (const m of c.messages) {
      console.log(`  [${m.author}] ${m.text}`);
    }
    console.log('');
  }
  console.log(`${waiting.length} waiting in story set "${set.id}". Reply with: node comments.mjs reply <id> <changed|declined|answered> "<text>"`);
} else if (command === 'reply') {
  const [id, status, ...rest] = args;
  let text = rest.join(' ');
  if (text === '-') {
    text = fs.readFileSync(0, 'utf8');
  }
  text = text.trim();
  if (!id || !['changed', 'declined', 'answered'].includes(status) || !text) {
    console.error('Usage: node comments.mjs reply <id> <changed|declined|answered> "<text>"');
    process.exit(1);
  }
  // Read just before writing so a comment the reviewer added meanwhile is kept.
  const data = load();
  const c = data.comments.find(x => x.id === id);
  if (!c) {
    console.error(`No comment with id ${id}.`);
    process.exit(1);
  }
  if (c.source !== 'local') {
    console.error(`${id} is a pull request comment. Only local comments are answered here.`);
    process.exit(1);
  }
  c.messages.push({ author: 'agent', at: new Date().toISOString(), text });
  c.status = status;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
  console.log(`Replied to ${id} (${status}). ${data.comments.filter(isWaiting).length} still waiting.`);
} else {
  console.error('Usage: node comments.mjs list | reply <id> <changed|declined|answered> "<text>"');
  process.exit(1);
}
