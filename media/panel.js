// Story panel webview. The extension owns all state; this file renders it and reports clicks.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let state = null;
  let last = { view: null, story: -1, step: -1 };
  let opened = false;
  const local = { linkForm: false, copied: '' };

  const ICON = {
    arrow: '<svg aria-hidden="true" width="14" height="10" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6h15M12 2l4 4-4 4"/></svg>',
    down: '<svg aria-hidden="true" width="10" height="14" viewBox="0 0 12 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1v15M2 12l4 4 4-4"/></svg>',
    check: '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg>',
    left: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2L3.5 6l4 4"/></svg>',
    right: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2l4 4-4 4"/></svg>'
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function delta(additions, deletions) {
    return [additions ? `+${additions}` : '', deletions ? `−${deletions}` : ''].filter(Boolean).join(' ');
  }

  function storyMeta(story) {
    const changed = story.steps.filter(s => s.changed).length;
    const parts = [story.entryPoint, `${plural(story.steps.length, 'method', 'methods')}, ${changed} changed`];
    return parts.filter(Boolean).join(' · ');
  }

  function stepStatus(step, index) {
    if (step.changed) {
      return `Changed ${delta(step.additions, step.deletions)}`.trim();
    }
    return index === 0 ? 'Unchanged · entry point' : 'Unchanged';
  }

  // --- overview ---------------------------------------------------------------------------------

  function progress(doc) {
    const done = doc.stories.filter(s => state.reviewed.includes(s.id)).length;
    const pct = doc.stories.length ? Math.round((done / doc.stories.length) * 100) : 0;
    return `<div class="progress">
      <div class="muted small">${done} of ${plural(doc.stories.length, 'story', 'stories')} reviewed</div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
    </div>`;
  }

  // One line that accounts for every changed file, so the reviewer can see nothing is hidden.
  function coverage() {
    const c = state.coverage;
    if (!c) {
      return '';
    }
    const missing = state.unstoried.filter(f => f.missing).length;
    const explained = c.changed - c.storied - missing;
    const parts = [`${c.storied} in stories`, `${explained} not in a story`];
    return `<div class="muted small">Of ${plural(c.changed, 'changed file', 'changed files')}: ${parts.join(', ')}${
      missing ? `, <span class="warn strong">${missing} missing from the stories file</span>` : ''
    }</div>`;
  }

  function fileGroup(reason, files, extra) {
    return `<div class="group${extra ? ' missing' : ''}">
      <div class="group-head"><span class="strong${extra ? ' warn' : ''}">${esc(reason)}</span><span class="muted small">${plural(files.length, 'file', 'files')}</span></div>
      ${extra || ''}
      <div class="files">${files.map(f => `<button class="file mono" data-a="unstoriedFile" data-path="${esc(f.path)}" title="Open the diff">${esc(f.path)}</button>`).join('')}</div>
    </div>`;
  }

  // Changed files that are in no story, grouped by the reason they were left out.
  function unstoried(doc) {
    const files = state.unstoried;
    if (!files.length) {
      return state.coverage
        ? '<div class="section"><div class="eyebrow">CHANGES NOT IN A STORY</div><div class="muted">None. Every changed file is part of a story.</div></div>'
        : '';
    }
    const missing = files.filter(f => f.missing);
    const groups = new Map();
    for (const f of files.filter(x => !x.missing)) {
      const reason = f.reason || 'No reason given';
      groups.set(reason, [...(groups.get(reason) || []), f]);
    }
    const ask = `<span class="small">These files changed, but the stories file does not mention them, so nothing says why they are left out. In your agent chat, ask:</span>
      <div class="prompt"><span class="mono">${esc(state.refreshPrompt)}</span>${copyButton(state.refreshPrompt)}</div>`;
    const summary = doc.unstoried && doc.unstoried.summary;
    return `<div class="section">
      <div class="eyebrow">CHANGES NOT IN A STORY · ${plural(files.length, 'FILE', 'FILES')}</div>
      ${summary ? `<p>${esc(summary)}</p>` : ''}
      <div class="muted small">These files changed but are on no story's path. Each group gives the reason. Click a file to see its diff.${
        state.coverage ? '' : ' The change could not be read from git, so this list is only what the stories file says.'
      }</div>
      ${missing.length ? fileGroup('Missing from the stories file', missing, ask) : ''}
      ${[...groups].map(([reason, list]) => fileGroup(reason, list)).join('')}
    </div>`;
  }

  // Each change has its own set of stories and comments. Shown once there is more than one to choose from.
  function setBar() {
    if (state.sets.length < 2) {
      return '';
    }
    const options = state.sets.map(s => `<option value="${esc(s.id)}"${s.id === state.setId ? ' selected' : ''}>${esc(s.title)} (${esc(s.id)})</option>`);
    return `<div class="setbar">
      <label for="setPick" class="muted small">Story set</label>
      <select id="setPick">${options.join('')}</select>
      <button class="btn" data-a="deleteSet">Delete set</button>
    </div>`;
  }

  function overview(doc) {
    const sub = doc.head && doc.base ? `${doc.head} compared with ${doc.base}` : doc.head || '';
    const stats = doc.stats ? `${plural(doc.stats.files, 'file', 'files')} changed, +${doc.stats.additions} −${doc.stats.deletions}` : '';
    const stories = doc.stories.map((story, i) => {
      const reviewed = state.reviewed.includes(story.id);
      const lastOpened = i === state.storyIndex && opened ? ' · Last opened' : '';
      return `<button class="row story" data-a="story" data-i="${i}">
        <span class="num${reviewed ? ' done' : ''}">${reviewed ? ICON.check : i + 1}</span>
        <span class="col">
          <span class="strong">${esc(story.title)}</span>
          <span>${esc(story.goal)}</span>
          <span class="muted small">${esc(storyMeta(story))}${reviewed ? ' · Reviewed' : ''}${lastOpened}</span>
        </span>
      </button>`;
    });
    return `<div class="page">
      <div class="eyebrow">STORIES · OVERVIEW</div>
      ${setBar()}
      <div>
        <h1>${esc(doc.title)}</h1>
        <div class="mono muted small">${esc(sub)}</div>
        <div class="muted small">${esc(stats)}</div>
        ${coverage()}
      </div>
      <p class="lead">This change tells ${plural(doc.stories.length, 'story', 'stories')}. Each one starts at its entry point and follows the calls down to the code that changed.</p>
      ${progress(doc)}
      <div class="list">${stories.join('')}</div>
      ${unstoried(doc)}
      ${commentsSection()}
    </div>`;
  }

  // --- story ------------------------------------------------------------------------------------

  function sequence(story) {
    const lanes = [];
    for (const step of story.steps) {
      if (!lanes.includes(step.participant)) {
        lanes.push(step.participant);
      }
    }
    const width = 100 / lanes.length;
    const heads = lanes.map((name, li) => {
      const steps = story.steps.filter(s => s.participant === name);
      const changed = steps.some(s => s.changed);
      const first = story.steps.findIndex(s => s.participant === name);
      const label = changed
        ? delta(steps.reduce((n, s) => n + s.additions, 0), steps.reduce((n, s) => n + s.deletions, 0)) || 'CHANGED'
        : li === 0 ? 'ENTRY' : ' ';
      const short = name.replace(/([a-z0-9])([A-Z])/g, '$1​$2').replace(/([./_])/g, '$1​');
      return `<div class="lane"><button class="lane-head${changed ? ' changed' : ''}" data-a="step" data-i="${first}" title="${esc(name)}">
        <span class="small">${esc(label)}</span><span class="mono">${esc(short)}</span>
      </button></div>`;
    });
    const lifelines = lanes.map(() => '<div class="lane"><div class="lifeline"></div></div>').join('');
    const rows = story.steps.map((step, i) => {
      const to = lanes.indexOf(step.participant);
      const from = step.caller >= 0 ? lanes.indexOf(story.steps[step.caller].participant) : -1;
      let left = 0;
      let span = (to + 0.5) * width;
      let cls = 'entry';
      if (from >= 0 && from < to) {
        cls = 'fwd';
        left = (from + 0.5) * width;
        span = (to - from) * width;
      } else if (from > to) {
        left = (to + 0.5) * width;
        span = (from - to) * width;
        cls = 'back';
      } else if (from === to) {
        left = (to + 0.5) * width;
        span = width / 2;
        cls = 'self';
      }
      const caller = from < 0 ? 'request' : story.steps[step.caller].participant;
      return `<button class="msg${i === state.stepIndex ? ' current' : ''}${step.changed ? ' changed' : ''}" data-a="step" data-i="${i}"
        aria-label="Step ${i + 1}: ${esc(caller)} calls ${esc(step.name)}">
        <span class="arrow ${cls}" style="left:${left.toFixed(3)}%;width:${span.toFixed(3)}%">
          <span class="arrow-label"><span class="n">${i + 1}</span><span class="mono">${esc(step.call)}</span></span>
          <span class="arrow-line"><span class="shaft"></span><span class="head"></span></span>
        </span>
      </button>`;
    });
    return `<section class="card seq" aria-label="Sequence diagram of this story">
      <div class="seq-scroll"><div class="seq-inner" style="min-width:${lanes.length * 92}px">
        <div class="lanes">${heads.join('')}</div>
        <div class="msgs"><div class="lanes lifelines" aria-hidden="true">${lifelines}</div>${rows.join('')}</div>
      </div></div>
      <p class="muted small">Each box is a class and each arrow is a method call. Filled is changed code. Click an arrow or a class to open that step.</p>
    </section>`;
  }

  function sample(step) {
    const s = step.sample;
    if (!s || (!s.input && !s.output)) {
      return '';
    }
    const source = s.source === 'test' ? 'From test' : 'Generated from types';
    const note = [s.test, s.note].filter(Boolean).join('. ');
    return `<div class="sample">
      ${s.input ? `<div><div class="sample-head"><span class="eyebrow">SAMPLE INPUT</span><span class="chip${s.source === 'test' ? '' : ' dashed'}">${source}</span></div><pre>${esc(s.input)}</pre></div>` : ''}
      ${s.output ? `<div><div class="sample-head"><span class="eyebrow">SAMPLE OUTPUT</span></div><pre>${esc(s.output)}</pre></div>` : ''}
      ${note ? `<div class="muted small">${esc(note)}</div>` : ''}
    </div>`;
  }

  function stepCard(story, step, i) {
    const selected = i === state.stepIndex;
    const lines = step.lines.map(l => {
      const target = l.line ?? l.at ?? step.focusLine;
      const active = selected && l.kind !== 'del' && l.line === state.line;
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
      return `<button class="line ${l.kind}${active ? ' active' : ''}" data-a="step" data-i="${i}" data-line="${target}">
        <span class="no">${l.line ?? ''}</span><span class="sign">${sign}</span><span class="text">${esc(l.text) || ' '}</span>
      </button>`;
    });
    const actions = selected
      ? `<div class="actions">
          ${step.changed ? `<button class="btn" data-a="diff" data-i="${i}">Open diff in editor</button>` : ''}
          <button class="btn" data-a="file" data-i="${i}">Open file in editor</button>
        </div>`
      : '';
    const card = `<section class="card step${selected ? ' selected' : ''}" id="step-${i}">
      <div class="step-head">
        <span class="num${step.changed ? ' changed' : ''}">${i + 1}</span>
        <h2 class="mono">${esc(step.name)}</h2>
        <span class="chip${step.changed ? ' changed' : ''}">${esc(stepStatus(step, i))}</span>
      </div>
      <div class="mono muted small">${esc(step.file)}:${step.focusLine}</div>
      ${step.summary ? `<div>${esc(step.summary)}</div>` : ''}
      <div class="code">${lines.join('')}</div>
      ${selected ? sample(step) : ''}
      ${actions}
    </section>`;
    const next = story.steps[i + 1];
    const connector = next ? `<div class="calls muted small">${ICON.down}<span>calls <span class="mono">${esc(next.call)}</span></span></div>` : '';
    return card + connector;
  }

  function story(doc) {
    const s = doc.stories[state.storyIndex];
    const count = doc.stories.length;
    const reviewed = state.reviewed.includes(s.id);
    return `<div class="page">
      <div class="topbar">
        <button class="btn" data-a="overview">${ICON.left}All stories</button>
        <div class="pager">
          <button class="btn icon" data-a="story" data-i="${state.storyIndex - 1}" aria-label="Previous story" ${state.storyIndex === 0 ? 'disabled' : ''}>${ICON.left}</button>
          <span class="muted small">Story ${state.storyIndex + 1} of ${count}</span>
          <button class="btn icon" data-a="story" data-i="${state.storyIndex + 1}" aria-label="Next story" ${state.storyIndex === count - 1 ? 'disabled' : ''}>${ICON.right}</button>
        </div>
      </div>
      <div>
        <h1>${esc(s.title)}</h1>
        <div class="goal"><div class="eyebrow accent">GOAL</div><p>${esc(s.goal)}</p></div>
        <div class="muted small">${s.entryPoint ? `Entry point <span class="mono">${esc(s.entryPoint)}</span> · ` : ''}${plural(s.steps.length, 'method', 'methods')}, ${s.steps.filter(x => x.changed).length} changed</div>
      </div>
      ${sequence(s)}
      <div class="stepnav">
        <span class="strong">Step ${state.stepIndex + 1} of ${s.steps.length}</span>
        <div class="pager">
          <button class="btn" data-a="move" data-d="-1" ${state.stepIndex === 0 ? 'disabled' : ''}>Previous step</button>
          <button class="btn" data-a="move" data-d="1" ${state.stepIndex === s.steps.length - 1 ? 'disabled' : ''}>Next step</button>
        </div>
      </div>
      <div class="muted small">Click any line to open that file at that line in the editor. To comment, select one line or a block of lines in the editor, then use the plus in the gutter. Samples show for the step you are on.</div>
      <div class="steps">${s.steps.map((step, i) => stepCard(s, step, i)).join('')}</div>
      ${commentsSection()}
      <button class="btn ${reviewed ? '' : 'primary '}wide" data-a="reviewed">${ICON.check}${reviewed ? 'Reviewed. Mark as not reviewed' : nextLabel(doc)}</button>
    </div>`;
  }

  function nextLabel(doc) {
    const next = doc.stories.findIndex((s, i) => i !== state.storyIndex && !state.reviewed.includes(s.id));
    return next >= 0 ? `Mark reviewed and go to story ${next + 1}` : 'Mark story reviewed';
  }

  // --- comments ---------------------------------------------------------------------------------

  function copyButton(text) {
    return `<button class="btn" data-a="copy" data-text="${esc(text)}">${local.copied === text ? 'Copied' : 'Copy prompt'}</button>`;
  }

  function commentsSection() {
    let link;
    if (state.pr) {
      link = `<div class="note"><span>Linked to PR #${state.pr.number}. You can comment locally or on the PR.</span>
        <span class="pager"><button class="btn" data-a="refreshPr">Fetch replies</button><button class="btn" data-a="unlinkPr">Unlink</button></span></div>`;
    } else if (local.linkForm) {
      link = `<div class="note form">
        <div class="col grow"><label for="prUrl" class="small">Pull request link</label>
        <input id="prUrl" type="url" placeholder="https://github.com/your-org/your-repo/pull/482"></div>
        <button class="btn primary" data-a="linkSubmit">Link PR</button>
      </div>`;
    } else {
      link = `<div class="note"><span>Local comments are on. No pull request is linked yet.</span><button class="btn" data-a="linkOpen">Link a PR</button></div>`;
    }
    const handoff = state.waiting
      ? `<div class="handoff">
          <span class="strong warn">${state.waiting === 1 ? '1 comment is waiting for your agent' : `${state.waiting} comments are waiting for your agent`}</span>
          <span class="small">Local comments are saved with the stories in .stories/. In your agent chat, ask:</span>
          <div class="prompt"><span class="mono">${esc(state.agentPrompt)}</span>${copyButton(state.agentPrompt)}</div>
          <span class="muted small">The agent replies in the thread, and either makes the change or says why not.</span>
        </div>`
      : '';
    const list = state.comments.length
      ? `<div class="list">${state.comments.map(c => `<button class="row comment" data-a="comment" data-id="${esc(c.id)}">
          <span class="comment-head"><span class="mono small">${esc(c.where)}</span><span class="small status ${esc(c.status)}">${esc(c.statusLabel)}</span></span>
          <span class="clip">${esc(c.first)}</span>
        </button>`).join('')}</div>`
      : '';
    return `<div class="section"><div class="eyebrow">COMMENTS</div>${link}${handoff}${list}</div>`;
  }

  // --- shell ------------------------------------------------------------------------------------

  function empty() {
    return `<div class="page">
      <div class="eyebrow">STORIES</div>
      <h1>No stories yet</h1>
      <p class="lead">Stories are written by your AI agent into <span class="mono">.stories/</span>, one folder per change. Install the skill once, then ask the agent in its chat:</p>
      <div class="prompt"><span class="mono">${esc(state.createPrompt)}</span>${copyButton(state.createPrompt)}</div>
      <div><button class="btn primary" data-a="installSkill">Install agent skill</button></div>
    </div>`;
  }

  function render() {
    if (!state) {
      return;
    }
    const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    let html;
    if (state.error) {
      html = `<div class="page"><div class="banner error">${esc(state.error)}</div></div>`;
    } else if (!state.doc || !state.doc.stories.length) {
      html = empty();
    } else {
      const stale = state.stale
        ? '<div class="banner">The code has moved on since these stories were written. Ask your agent to refresh them.</div>'
        : '';
      const foreign = state.foreign
        ? `<div class="banner">You are on branch <span class="mono">${esc(state.foreign.branch)}</span>. These stories were written for <span class="mono">${esc(state.foreign.writtenFor)}</span>.</div>`
        : '';
      html = foreign + stale + (state.view === 'story' ? story(state.doc) : overview(state.doc));
    }
    root.innerHTML = html;
    const samePage = last.view === state.view && last.story === state.storyIndex;
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = samePage ? scroll : 0;
    }
    if (samePage && state.view === 'story' && last.step !== state.stepIndex) {
      const card = document.getElementById(`step-${state.stepIndex}`);
      if (card && card.scrollIntoView) {
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    opened = opened || state.view === 'story';
    last = { view: state.view, story: state.storyIndex, step: state.stepIndex };
  }

  function post(message) {
    vscode.postMessage(message);
  }

  root.addEventListener('click', event => {
    const el = event.target.closest('[data-a]');
    if (!el || el.disabled) {
      return;
    }
    const d = el.dataset;
    switch (d.a) {
      case 'story': return post({ type: 'openStory', index: Number(d.i) });
      case 'overview': return post({ type: 'overview' });
      case 'step': return post({ type: 'step', index: Number(d.i), line: d.line ? Number(d.line) : undefined });
      case 'move': return post({ type: 'moveStep', delta: Number(d.d) });
      case 'diff': return post({ type: 'openDiff', index: Number(d.i) });
      case 'file': return post({ type: 'openFile', index: Number(d.i) });
      case 'reviewed': return post({ type: 'toggleReviewed' });
      case 'deleteSet': return post({ type: 'deleteSet' });
      case 'unstoriedFile': return post({ type: 'openUnstoried', path: d.path });
      case 'comment': return post({ type: 'openComment', id: d.id });
      case 'unlinkPr': return post({ type: 'unlinkPr' });
      case 'refreshPr': return post({ type: 'refreshPr' });
      case 'installSkill': return post({ type: 'installSkill' });
      case 'linkOpen':
        local.linkForm = true;
        render();
        document.getElementById('prUrl').focus();
        return;
      case 'linkSubmit':
        return post({ type: 'linkPr', url: document.getElementById('prUrl').value });
      case 'copy':
        post({ type: 'copy', text: d.text });
        local.copied = d.text;
        return render();
    }
  });

  root.addEventListener('change', event => {
    if (event.target.id === 'setPick') {
      post({ type: 'selectSet', id: event.target.value });
    }
  });

  root.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.id === 'prUrl') {
      post({ type: 'linkPr', url: event.target.value });
    }
  });

  window.addEventListener('message', event => {
    if (event.data && event.data.type === 'state') {
      state = event.data.state;
      if (state.pr) {
        local.linkForm = false;
      }
      render();
    }
  });

  post({ type: 'ready' });
})();
