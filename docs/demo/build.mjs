#!/usr/bin/env node
// Builds docs/demo/index.html: the real story panel in a plain web page, with a small stand-in for
// the editor so the panel can be clicked through without installing anything.
//
//   npm run compile
//   node docs/demo/build.mjs <folder that has .stories/>
//
// The page holds a snapshot of that folder's stories. Build it again after the panel changes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const workspace = path.resolve(process.argv[2] ?? '.');
const server = path.join(repo, 'out', 'core', 'server.js');
if (!fs.existsSync(server)) {
  console.error('Run "npm run compile" first: out/core/server.js is missing.');
  process.exit(1);
}

/** Asks the shared core for the panel state of the workspace. */
function readState() {
  return new Promise((resolve, reject) => {
    const marks = path.join(os.tmpdir(), `code-stories-demo-${process.pid}.json`);
    const child = spawn(process.execPath, [server, '--root', workspace, '--state', marks], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buffer = '';
    let state;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (message.type === 'state') {
          state = message.state;
        }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'panel', message: { type: 'ready' } }) + '\n');
    // The line counts arrive after git has answered, so wait a moment for the last state.
    setTimeout(() => {
      child.stdin.end();
      fs.rmSync(marks, { force: true });
      state?.doc ? resolve(state) : reject(new Error(`No stories found in ${workspace}`));
    }, 4000);
  });
}

const state = await readState();
const css = fs.readFileSync(path.join(repo, 'media', 'panel.css'), 'utf8');
const js = fs.readFileSync(path.join(repo, 'media', 'panel.js'), 'utf8');
const embed = value => JSON.stringify(value).replace(/</g, '\\u003c');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Stories: try the panel</title>
<style>
:root {
  color-scheme: dark;
  --vscode-foreground: #cccccc; --vscode-editor-background: #1f1f1f; --vscode-sideBar-background: #181818;
  --vscode-descriptionForeground: #9d9d9d; --vscode-widget-border: #3c3c3c; --vscode-focusBorder: #0078d4;
  --vscode-button-background: #0078d4; --vscode-button-hoverBackground: #026ec1; --vscode-button-foreground: #ffffff;
  --vscode-textLink-foreground: #4daafc; --vscode-input-foreground: #cccccc; --vscode-input-background: #313131;
  --vscode-list-hoverBackground: rgba(255,255,255,0.06); --vscode-list-inactiveSelectionBackground: rgba(0,120,212,0.18);
  --vscode-toolbar-hoverBackground: rgba(255,255,255,0.08); --vscode-textCodeBlock-background: #181818;
  --vscode-editorLineNumber-foreground: #6e7681; --vscode-diffEditor-insertedLineBackground: rgba(73,156,84,0.25);
  --vscode-diffEditor-removedLineBackground: rgba(219,92,92,0.25); --vscode-editor-findMatchHighlightBackground: rgba(214,174,88,0.28);
  --vscode-inputValidation-warningBackground: rgba(214,145,60,0.22); --vscode-inputValidation-errorBackground: rgba(219,92,92,0.22);
  --vscode-charts-orange: #e0984f; --vscode-charts-green: #6aab73; --vscode-charts-red: #e06c6c; --vscode-charts-yellow: #d6ae58;
  --vscode-font-family: 'Segoe UI', system-ui, sans-serif; --vscode-font-size: 13px;
  --vscode-editor-font-family: Consolas, ui-monospace, monospace; --vscode-editor-font-size: 12px;
  --tok-kw: #569cd6; --tok-str: #ce9178; --tok-com: #6a9955; --tok-num: #b5cea8; --tok-fn: #dcdcaa; --tok-type: #4ec9b0; --tok-meta: #c586c0;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --vscode-foreground: #1f1f1f; --vscode-editor-background: #ffffff; --vscode-sideBar-background: #f6f6f6;
    --vscode-descriptionForeground: #5f5f5f; --vscode-widget-border: #d4d4d4; --vscode-textLink-foreground: #005fb8;
    --vscode-input-foreground: #1f1f1f; --vscode-input-background: #ffffff; --vscode-textCodeBlock-background: #f6f6f6;
    --vscode-list-hoverBackground: rgba(0,0,0,0.05); --vscode-toolbar-hoverBackground: rgba(0,0,0,0.06);
    --vscode-editorLineNumber-foreground: #6e7681; --vscode-diffEditor-insertedLineBackground: rgba(73,156,84,0.18);
    --vscode-diffEditor-removedLineBackground: rgba(219,92,92,0.16); --vscode-editor-findMatchHighlightBackground: rgba(245,200,90,0.35);
    --vscode-inputValidation-warningBackground: rgba(245,180,90,0.25);
    --vscode-charts-orange: #a85d00; --vscode-charts-green: #2e7d32; --vscode-charts-red: #c62828; --vscode-charts-yellow: #9a7500;
    --tok-kw: #0000ff; --tok-str: #a31515; --tok-com: #008000; --tok-num: #098658; --tok-fn: #795e26; --tok-type: #267f99; --tok-meta: #af00db;
  }
}
#demo-bar { position: sticky; top: 0; z-index: 2; box-sizing: border-box; padding: 8px 16px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font: 13px/1.5 var(--vscode-font-family); display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: space-between; }
#demo-editor { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); }
</style>
<style>${css}</style>
</head>
<body>
<div id="demo-bar">
  <span>This is the real story panel with sample stories. In your editor, it sits beside the code.</span>
  <span id="demo-editor">The editor is idle.</span>
</div>
<div id="root"></div>
<script>
// A stand-in for the editor. The panel sends it the same messages it sends VS Code or IntelliJ.
(function () {
  var state = ${embed(state)};
  var editor = document.getElementById('demo-editor');
  function say(text) { editor.textContent = text; }
  function push() { window.postMessage({ type: 'state', state: state }, '*'); }
  function story() { return state.doc.stories[state.storyIndex]; }
  function goTo(index, line) {
    var step = story().steps[index];
    if (!step) { return; }
    state.view = 'story';
    state.stepIndex = index;
    state.line = line || step.focusLine || 0;
    say(step.removed ? 'The editor shows ' + step.file + ' as it was on ' + (state.doc.base || 'the base') + '.' : 'The editor is at ' + step.file + ':' + state.line + '.');
  }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        switch (m.type) {
          case 'ready': break;
          case 'openStory': if (state.doc.stories[m.index]) { state.storyIndex = m.index; goTo(0); } break;
          case 'overview': state.view = 'overview'; say('The editor is idle.'); break;
          case 'step': goTo(m.index, m.line); break;
          case 'openFile': goTo(m.index); break;
          case 'moveStep': goTo(Math.max(0, Math.min(story().steps.length - 1, state.stepIndex + m.delta))); break;
          case 'toggleReviewed': {
            var mine = state.insights[state.storyIndex];
            if (mine.status === 'reviewed') { mine.status = 'new'; break; }
            mine.status = 'reviewed';
            var next = state.insights.findIndex(function (s, i) { return i !== state.storyIndex && s.status !== 'reviewed'; });
            if (next >= 0) { state.storyIndex = next; goTo(0); } else { state.view = 'overview'; }
            break;
          }
          case 'copy': if (navigator.clipboard) { navigator.clipboard.writeText(m.text).catch(function () {}); } say('Copied: ' + m.text); break;
          case 'openDiff': say('The editor shows the diff of ' + story().steps[m.index].file + '.'); break;
          case 'openUnstoried': case 'openLines': say('The editor shows the diff of ' + m.path + '.'); break;
          case 'openTest': say('The editor opens the test "' + state.doc.stories[m.story].tests[m.index].name + '".'); break;
          case 'openComment': say('The editor opens the comment thread.'); break;
          default: say('This action needs the editor plugin.');
        }
        setTimeout(push, 0);
      }
    };
  };
})();
</script>
<script>${js}</script>
</body>
</html>
`;
fs.writeFileSync(path.join(here, 'index.html'), page);
console.log(`Wrote docs/demo/index.html from ${workspace} (${state.doc.stories.length} stories)`);
