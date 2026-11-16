// Story panel webview. The extension owns all state; this file renders it and reports clicks.
// Each screen shows one kind of information at a time: the overview and a story both have tabs.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let state = null;
  let last = { view: null, story: -1, step: -1, tab: '' };
  let opened = false;
  const local = { linkForm: false, copied: '', tab: 'stories', storyTab: 'steps' };

  const ICON = {
    arrow: '<svg aria-hidden="true" width="14" height="10" viewBox="0 0 18 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6h15M12 2l4 4-4 4"/></svg>',
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

  // Syntax colours for the code of a step. A step shows a few lines of a file, not the file, so
  // this is a small scanner that works line by line: comments, strings, numbers, keywords, types
  // and function names. It is the same code in VS Code, IntelliJ and the demo page.
  const HL = (function () {
    const words = text => new Set(text.split(' '));
    const KEYWORDS = words('abstract as assert async await break case catch class const constructor continue debugger def default defer del delete do elif else elsif end enum except export extends final finally fn for foreach from fun func function go goto if impl implements import in inline instanceof interface internal is lambda let loop match mod module mut namespace new not object of open operator or and override package pass private protected pub public raise readonly require return sealed static struct super suspend switch then throw throws trait try type typeof unless until use using val var virtual void when where while with yield');
    const LITERALS = words('true false null nil None True False undefined NaN this self');
    const PRIMITIVES = words('int long float double string boolean bool char byte short str number any unknown never bigint symbol i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 usize isize');
    const SQL = words('select from where insert into values update set delete create table alter drop join left right inner outer on group by order having limit as and or not null primary key distinct union index view begin commit rollback case when then else end');
    const C = { line: ['//'], block: [['/*', '*/']], quotes: '"\'`' };
    const FAMILIES = [
      ['js jsx ts tsx mjs cjs java kt kts c h cc cpp hpp cs go swift php scala dart groovy gradle proto', C],
      ['rs', { line: ['//'], block: [['/*', '*/']], quotes: '"' }],
      ['py rb sh bash zsh yml yaml toml pl r ex exs tf', { line: ['#'], block: [], quotes: '"\'', triple: true }],
      ['sql', { line: ['--'], block: [['/*', '*/']], quotes: '\'"', sql: true }],
      ['lua hs', { line: ['--'], block: [], quotes: '"\'' }],
      ['css scss less', { line: [], block: [['/*', '*/']], quotes: '"\'' }],
      ['html htm xml vue svelte', { line: [], block: [['<!--', '-->']], quotes: '"\'' }],
      ['json', { line: [], block: [], quotes: '"' }]
    ];
    const BY_EXT = new Map();
    for (const [exts, family] of FAMILIES) {
      for (const ext of exts.split(' ')) {
        BY_EXT.set(ext, family);
      }
    }
    const IDENT = /[A-Za-z_$][\w$]*/y;
    const NUMBER = /(0[xX][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)[a-zA-Z]*/y;

    /** The rules for a file, from its extension; undefined for a file that is not code. */
    function family(file) {
      const name = String(file || '').split(/[\\/]/).pop().toLowerCase();
      if (name === 'dockerfile' || name === 'makefile') {
        return BY_EXT.get('sh');
      }
      return BY_EXT.get(name.includes('.') ? name.split('.').pop() : '');
    }

    /** One line as HTML. `carry.open` holds a comment or string that is still open from the line before. */
    function line(text, rules, carry) {
      if (!rules) {
        return esc(text);
      }
      let out = '';
      let plain = '';
      const flush = () => { out += esc(plain); plain = ''; };
      const put = (cls, s) => { flush(); out += `<span class="t-${cls}">${esc(s)}</span>`; };
      let i = 0;
      if (carry.open) {
        const end = text.indexOf(carry.open.end);
        if (end < 0) {
          put(carry.open.cls, text);
          return out;
        }
        i = end + carry.open.end.length;
        put(carry.open.cls, text.slice(0, i));
        carry.open = null;
      }
      scan: while (i < text.length) {
        const ch = text[i];
        if (text[i - 1] !== '\\') {
          for (const mark of rules.line) {
            if (text.startsWith(mark, i)) {
              put('com', text.slice(i));
              return out;
            }
          }
        }
        const blocks = rules.triple ? [['"""', '"""', 'str'], ["'''", "'''", 'str']] : rules.block.map(b => [b[0], b[1], 'com']);
        for (const [start, stop, cls] of blocks) {
          if (text.startsWith(start, i)) {
            const end = text.indexOf(stop, i + start.length);
            if (end < 0) {
              put(cls, text.slice(i));
              carry.open = { end: stop, cls };
              return out;
            }
            put(cls, text.slice(i, end + stop.length));
            i = end + stop.length;
            continue scan;
          }
        }
        if (rules.quotes.includes(ch)) {
          let end = i + 1;
          while (end < text.length && text[end] !== ch) {
            end += text[end] === '\\' ? 2 : 1;
          }
          if (end < text.length) {
            put('str', text.slice(i, end + 1));
            i = end + 1;
            continue;
          }
          if (ch === '`') {
            put('str', text.slice(i));
            carry.open = { end: '`', cls: 'str' };
            return out;
          }
          if (ch === '"') {
            put('str', text.slice(i));
            return out;
          }
          // A lone apostrophe is not a string.
          plain += ch;
          i++;
          continue;
        }
        if (ch >= '0' && ch <= '9' && !/[\w$]/.test(text[i - 1] || '')) {
          NUMBER.lastIndex = i;
          const m = NUMBER.exec(text);
          if (m) {
            put('num', m[0]);
            i += m[0].length;
            continue;
          }
        }
        if (ch === '@' && /[A-Za-z_]/.test(text[i + 1] || '')) {
          IDENT.lastIndex = i + 1;
          const m = IDENT.exec(text);
          put('meta', '@' + m[0]);
          i += m[0].length + 1;
          continue;
        }
        IDENT.lastIndex = i;
        const m = IDENT.exec(text);
        if (m) {
          const word = m[0];
          i += word.length;
          const key = rules.sql ? word.toLowerCase() : word;
          if (text[i - word.length - 1] === '.' && !LITERALS.has(word)) {
            // A member name: a function when it is called, otherwise plain.
            if (/^\s*\(/.test(text.slice(i))) { put('fn', word); } else { plain += word; }
          } else if (rules.sql ? SQL.has(key) : KEYWORDS.has(word)) {
            put('kw', word);
          } else if (LITERALS.has(word)) {
            put('lit', word);
          } else if (/^\s*\(/.test(text.slice(i))) {
            put('fn', word);
          } else if (PRIMITIVES.has(word) || /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(word)) {
            put('type', word);
          } else {
            plain += word;
          }
          continue;
        }
        plain += ch;
        i++;
      }
      flush();
      return out;
    }

    return { family, line };
  })();

  function delta(additions, deletions) {
    return [additions ? `+${additions}` : '', deletions ? `−${deletions}` : ''].filter(Boolean).join(' ');
  }

  function insight(si) {
    return state.insights[si] || { status: 'new', steps: [] };
  }

  function stepInsight(si, i) {
    return insight(si).steps[i] || { stale: [], sameAs: -1, since: null, fresh: [] };
  }

  // --- what each step and story needs the reviewer to know --------------------------------------

  /** Changed lines of the file that sit inside the excerpt's range but that the excerpt does not show. */
  function hiddenChanged(step) {
    const added = state.added[step.file];
    const shown = step.lines.filter(l => l.line).map(l => l.line);
    if (!added || shown.length < 2 || step.removed) {
      return [];
    }
    const has = new Set(shown);
    return added.filter(n => n > shown[0] && n < shown[shown.length - 1] && !has.has(n));
  }

  function untested(story, step) {
    const mapped = story.tests.some(t => t.steps && t.steps.length);
    return step.changed && !step.removed && mapped && !story.tests.some(t => (t.steps || []).includes(step.id));
  }

  /** Short labels for a step, most urgent first. */
  function stepFlags(story, si, i) {
    const step = story.steps[i];
    const info = stepInsight(si, i);
    const flags = [];
    if (info.stale.length) flags.push({ text: 'Out of date', cls: 'warn' });
    if (story.risks.some(r => r.step === step.id)) flags.push({ text: 'Look closely', cls: 'warn' });
    if (untested(story, step)) flags.push({ text: 'No test', cls: 'warn' });
    if (info.since === 'changed') flags.push({ text: 'Changed since review', cls: 'accent' });
    if (info.since === 'new') flags.push({ text: 'New since review', cls: 'accent' });
    if (info.since === 'same') flags.push({ text: 'Same as when you reviewed', cls: 'muted' });
    else if (info.sameAs >= 0 && info.sameAs !== si) flags.push({ text: `Same as in story ${info.sameAs + 1}`, cls: 'muted' });
    return flags;
  }

  function storyFacts(story, si) {
    const stale = insight(si).steps.filter(s => s.stale.length).length;
    const hidden = story.steps.reduce((n, s) => n + hiddenChanged(s).length, 0);
    return { stale, hidden, risks: story.risks.length, tests: story.tests.length, changed: story.steps.filter(s => s.changed).length };
  }

  function stepStatus(step, index) {
    if (step.removed) {
      return `Removed ${delta(0, step.deletions)}`.trim();
    }
    if (step.changed) {
      return `Changed ${delta(step.additions, step.deletions)}`.trim();
    }
    return index === 0 ? 'Unchanged · entry point' : 'Unchanged';
  }

  function tabs(id, items, current) {
    return `<div class="tabs" role="tablist">${items.map(t => `<button role="tab" class="tab${t.id === current ? ' on' : ''}${t.warn ? ' warn' : ''}" aria-selected="${t.id === current}" data-a="${id}" data-tab="${t.id}">${esc(t.label)}${t.count === undefined ? '' : ` <span class="count">${t.count}</span>`}</button>`).join('')}</div>`;
  }

  function copyButton(text, label) {
    return `<button class="btn" data-a="copy" data-text="${esc(text)}">${local.copied === text ? 'Copied' : label || 'Copy prompt'}</button>`;
  }

  // --- overview ---------------------------------------------------------------------------------

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

  function allTests(doc) {
    const tests = new Map();
    doc.stories.forEach((story, si) => story.tests.forEach((t, index) => {
      const key = `${t.file}\n${t.name}`;
      const entry = tests.get(key) || { ...t, story: si, index, stories: [] };
      entry.stories.push(si + 1);
      tests.set(key, entry);
    }));
    return [...tests.values()];
  }

  /** The four counters at the top of the overview. Each one opens its own list. */
  function counters(doc) {
    const done = doc.stories.filter((_, i) => insight(i).status === 'reviewed').length;
    const missingFiles = state.unstoried.filter(f => f.missing).length;
    const unseen = state.lines ? state.lines.unseen : missingFiles;
    const gaps = doc.stories.filter(s => !s.tests.length).length;
    const items = [
      { id: 'stories', value: `${done} of ${doc.stories.length}`, label: 'Stories reviewed' },
      { id: 'lines', value: unseen, label: state.lines ? 'Lines not seen' : 'Files not covered', warn: unseen > 0 },
      { id: 'tests', value: allTests(doc).length, label: gaps ? `Tests · ${plural(gaps, 'gap', 'gaps')}` : 'Tests', warn: gaps > 0 },
      { id: 'comments', value: state.comments.length, label: state.waiting ? `Comments · ${state.waiting} waiting` : 'Comments', warn: state.waiting > 0 }
    ];
    return `<div class="counters" role="tablist">${items.map(t => `<button role="tab" class="counter${t.id === local.tab ? ' on' : ''}" aria-selected="${t.id === local.tab}" data-a="tab" data-tab="${t.id}">
      <span class="value${t.warn ? ' warn' : ''}">${esc(t.value)}</span><span class="small label">${esc(t.label)}</span>
    </button>`).join('')}</div>`;
  }

  function storiesTab(doc) {
    const rows = doc.stories.map((story, i) => {
      const status = insight(i).status;
      const facts = storyFacts(story, i);
      const meta = [
        `${plural(story.steps.length, 'function', 'functions')}, ${facts.changed} changed`,
        facts.tests ? plural(facts.tests, 'test', 'tests') : '<span class="warn">no test</span>',
        facts.risks ? `<span class="warn">${facts.risks} to look at</span>` : '',
        facts.stale ? `<span class="warn">${plural(facts.stale, 'step', 'steps')} out of date</span>` : ''
      ].filter(Boolean).join(' · ');
      const label = status === 'reviewed' ? 'Reviewed' : status === 'changed' ? 'Changed since review' : 'To review';
      return `<button class="row story" data-a="story" data-i="${i}" title="${esc(story.goal)}">
        <span class="num${status === 'reviewed' ? ' done' : ''}">${status === 'reviewed' ? ICON.check : i + 1}</span>
        <span class="col grow1">
          <span class="strong">${esc(story.title)}</span>
          <span class="muted small">${meta}</span>
        </span>
        <span class="small state ${status}">${label}</span>
      </button>`;
    });
    return `<div class="list">${rows.join('')}</div>
      <div><button class="btn" data-a="copySummary">${local.copied === '#summary' ? 'Copied' : 'Copy review summary'}</button></div>`;
  }

  function fileGroup(reason, files, extra) {
    return `<div class="group${extra ? ' missing' : ''}">
      <div class="group-head"><span class="strong${extra ? ' warn' : ''}">${esc(reason)}</span><span class="muted small">${plural(files.length, 'file', 'files')}</span></div>
      ${extra || ''}
      <div class="files">${files.map(f => `<button class="file mono" data-a="unstoriedFile" data-path="${esc(f.path)}" title="Open the diff">${esc(f.path)}</button>`).join('')}</div>
    </div>`;
  }

  function refreshAsk(text) {
    return `<span class="small">${text} In your agent chat, ask:</span>
      <div class="prompt"><span class="mono">${esc(state.refreshPrompt)}</span>${copyButton(state.refreshPrompt)}</div>`;
  }

  // Everything that changed and is not shown by a story: lines the stories skip, then whole files.
  function linesTab(doc) {
    const lines = state.lines;
    let bar = '<div class="muted small">No changed lines were found against the base of these stories, so they cannot be counted here. Any files below are the ones the stories file says it leaves out.</div>';
    if (lines) {
      const part = (n, cls) => (n ? `<div class="${cls}" style="flex:${n} 1 0"></div>` : '');
      bar = `<div class="strong">${lines.shown} of ${plural(lines.total, 'changed line', 'changed lines')} ${lines.shown === 1 ? 'is' : 'are'} shown in a story</div>
        <div class="cover" role="img" aria-label="${lines.shown} shown in a story, ${lines.tests} in tests, ${lines.leftOut} in files left out with a reason, ${lines.unseen} shown nowhere">${part(lines.shown, 'in')}${part(lines.tests, 'tests')}${part(lines.leftOut, 'out')}${part(lines.unseen, 'no')}</div>
        <div class="legend small">
          <span><i class="in"></i>${lines.shown} shown in a story step</span>
          ${lines.tests ? `<span><i class="tests"></i>${lines.tests} in tests the stories name</span>` : ''}
          <span><i class="out"></i>${lines.leftOut} in files left out, with a reason</span>
          <span class="${lines.unseen ? 'warn' : ''}"><i class="no"></i>${lines.unseen} shown nowhere</span>
        </div>
        <div class="muted small">Blank lines are not counted.</div>`;
    }
    const skipped = lines && lines.files.length
      ? `<div class="group missing">
          <div class="group-head"><span class="strong warn">Changed lines that no step shows</span><span class="muted small">${plural(lines.files.reduce((n, f) => n + f.count, 0), 'line', 'lines')} in ${plural(lines.files.length, 'file', 'files')}</span></div>
          ${refreshAsk('These files are in a story, but the stories skip over these changed lines. You would not see them by reading the stories. Click one to see it in the diff.')}
          <div class="files">${lines.files.map(f => `<button class="file split" data-a="lines" data-path="${esc(f.path)}" data-line="${f.first}" title="Open the diff at line ${f.first}">
            <span class="mono">${esc(f.path)}</span><span class="muted small">${plural(f.count, 'line', 'lines')} · ${esc(f.ranges)}</span></button>`).join('')}</div>
        </div>`
      : '';
    const files = state.unstoried;
    const missing = files.filter(f => f.missing);
    const groups = new Map();
    for (const f of files.filter(x => !x.missing)) {
      const reason = f.reason || 'No reason given';
      groups.set(reason, [...(groups.get(reason) || []), f]);
    }
    const summary = doc.unstoried && doc.unstoried.summary;
    const nothing = !skipped && !files.length ? '<div class="muted">Nothing is left out. Every changed line is part of a story.</div>' : '';
    const leftOut = groups.size
      ? `<div class="eyebrow">FILES LEFT OUT OF THE STORIES</div>
         ${summary ? `<p>${esc(summary)}</p>` : ''}
         <div class="muted small">On no story's path. Each group gives the reason. Click a file to see its diff.</div>
         ${[...groups].map(([reason, list]) => fileGroup(reason, list)).join('')}`
      : '';
    return `${bar}${nothing}${skipped}
      ${missing.length ? fileGroup('Missing from the stories file', missing, refreshAsk('These files changed, but the stories file does not mention them, so nothing says why they are left out.')) : ''}
      ${leftOut}`;
  }

  function testRow(t, sub) {
    return `<button class="row test" data-a="test" data-story="${t.story}" data-i="${t.index}" title="Open the test">
      <span class="col"><span class="mono strong">${esc(t.name)}</span><span class="muted small">${sub}</span></span>
    </button>`;
  }

  function testsTab(doc) {
    const tests = allTests(doc);
    const none = doc.stories.map((s, i) => (s.tests.length ? '' : `<div class="warn small">Story ${i + 1} has no test: ${esc(s.title)}.</div>`)).join('');
    if (!tests.length) {
      return `<div class="muted">The stories file lists no tests. Ask your agent to refresh the stories so each one names the tests that cover it.</div>${none}`;
    }
    return `<div class="muted small">The tests that exercise each story. Click one to open it.</div>
      <div class="list">${tests.map(t => testRow(t, `${esc(t.file)}${t.line ? `:${t.line}` : ''} · ${t.stories.length === 1 ? 'Story' : 'Stories'} ${t.stories.join(', ')}`)).join('')}</div>
      ${none}`;
  }

  function overview(doc) {
    const sub = doc.head && doc.base ? `${doc.head} compared with ${doc.base}` : doc.head || '';
    const stats = doc.stats ? `${plural(doc.stats.files, 'file', 'files')} changed, +${doc.stats.additions} −${doc.stats.deletions}` : '';
    const panel = local.tab === 'lines' ? linesTab(doc) : local.tab === 'tests' ? testsTab(doc) : local.tab === 'comments' ? commentsSection(state.comments) : storiesTab(doc);
    return `<div class="page">
      <div class="eyebrow">OVERVIEW</div>
      ${setBar()}
      <div>
        <h1>${esc(doc.title)}</h1>
        <div class="muted small"><span class="mono">${esc(sub)}</span>${sub && stats ? ' · ' : ''}${esc(stats)}</div>
      </div>
      ${counters(doc)}
      <div class="section" role="tabpanel">${panel}</div>
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
        : li === 0 ? 'ENTRY' : ' ';
      const short = name.replace(/([a-z0-9])([A-Z])/g, '$1\u200b$2').replace(/([./_])/g, '$1\u200b');
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
      <p class="muted small">Each box is a class and each arrow is a call. Filled is changed code. Click an arrow or a class to open that step.</p>
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

  function flagChips(flags) {
    return flags.map(f => `<span class="small flag ${f.cls}">${esc(f.text)}</span>`).join('');
  }

  /** A step that is not open: one line with its name, size and anything the reviewer should know. */
  function stepRow(story, si, step, i) {
    const size = step.removed ? delta(0, step.deletions) : step.changed ? delta(step.additions, step.deletions) : '';
    const quiet = !step.changed || stepInsight(si, i).since === 'same';
    return `<button class="row steprow${quiet ? ' quiet' : ''}" id="step-${i}" data-a="step" data-i="${i}">
      <span class="num${step.removed ? ' removed' : step.changed ? ' changed' : ''}">${i + 1}</span>
      <span class="mono name${step.removed ? ' struck' : ''}">${esc(step.name)}</span>
      <span class="flags">${size ? `<span class="small ${step.removed ? 'del' : 'accent'}">${size}</span>` : ''}${flagChips(stepFlags(story, si, i))}</span>
    </button>`;
  }

  function excerpt(step, i, info) {
    const added = new Set(state.added[step.file] || []);
    const stale = new Set(info.stale);
    const fresh = new Set(info.fresh);
    // The excerpt leaves lines out. Say so wherever it does, and whether the hidden lines changed.
    let shown = 0;
    const rules = HL.family(step.file);
    // A comment or a string can run over several lines. It carries on only while the lines follow
    // each other; removed lines are old code, so they do not take part.
    let carry = { open: null };
    let lastNo = 0;
    const coloured = state.hl && state.hl.story === state.storyIndex && state.hl.step === i ? state.hl.lines : null;
    const highlight = (l, li) => {
      // The editor's own colours, when the editor sent them. Otherwise the scanner above.
      const spans = coloured && coloured[li];
      if (spans) {
        return spans.map(([text, colour, style]) => colour || style
          ? `<span style="${colour ? `color:${esc(colour)};` : ''}${style & 1 ? 'font-style:italic;' : ''}${style & 2 ? 'font-weight:bold;' : ''}">${esc(text)}</span>`
          : esc(text)).join('');
      }
      const no = step.removed ? l.was : l.line;
      if (l.kind === 'del' && !step.removed) {
        return HL.line(l.text, rules, { open: null });
      }
      if (no !== lastNo + 1) {
        carry = { open: null };
      }
      lastNo = no;
      return HL.line(l.text, rules, carry);
    };
    return step.lines.map((l, li) => {
      const at = step.removed ? l.was : l.line ?? l.at;
      const target = at ?? step.focusLine;
      const skipped = shown && at ? at - shown - 1 : 0;
      if (at) {
        // A removed line sits just before `at`, so it does not use up a line number itself.
        shown = l.line || step.removed ? at : at - 1;
      }
      let gap = '';
      if (skipped > 0) {
        let changed = 0;
        for (let n = at - skipped; n < at && !step.removed; n++) {
          changed += added.has(n) ? 1 : 0;
        }
        const what = step.removed ? plural(skipped, 'removed line', 'removed lines') : plural(skipped, 'line', 'lines');
        const text = changed ? `${what} not shown, ${changed} of them changed` : step.removed ? `${what} not shown` : `${what} not shown, none of them changed`;
        gap = `<button class="gap${changed ? ' warn' : ''}" data-a="step" data-i="${i}" data-line="${at - skipped}" title="Open the file at the lines that are not shown">
            <span class="no">⋮</span><span>${text}</span>
          </button>`;
      }
      const off = l.line && stale.has(l.line);
      const active = l.kind !== 'del' && l.line === state.line;
      const sign = off ? '!' : l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
      const cls = `line ${l.kind}${l.calls ? ' makes-call' : ''}${off ? ' stale' : ''}${fresh.has(li) ? ' fresh' : ''}${active ? ' active' : ''}`;
      return `${gap}<button class="${cls}" data-a="step" data-i="${i}" data-line="${target}"${l.calls ? ' title="Added line that calls the next step"' : ''}>
        <span class="no">${(step.removed ? l.was : l.line) ?? ''}</span><span class="sign">${sign}</span><span class="text">${highlight(l, li) || ' '}</span>
      </button>`;
    }).join('');
  }

  /** The step that is open: its code, what to know about it, and its sample. */
  function stepCard(story, si, step, i) {
    const info = stepInsight(si, i);
    const notes = [];
    if (info.stale.length) {
      notes.push(`<div class="notice warn"><span class="strong">Out of date.</span> ${plural(info.stale.length, 'line', 'lines')} marked ! no longer ${info.stale.length === 1 ? 'matches' : 'match'} the file. It was edited after the story was written.</div>`);
    }
    for (const r of story.risks.filter(x => x.step === step.id)) {
      notes.push(`<div class="notice warn"><span class="strong">Look closely.</span> ${esc(r.text)}</div>`);
    }
    if (info.since === 'changed' || info.since === 'new') {
      notes.push(`<div class="notice accent"><span class="strong">${info.since === 'new' ? 'New since your review.' : 'Changed since your review.'}</span> Lines with a bar on the left are the ones you have not read.</div>`);
    }
    if (step.removed) {
      notes.push(`<div class="notice">This code was removed. It is shown as it was on ${esc(state.doc.base || 'the base')}, with the line numbers it had there.</div>`);
    }
    const covering = story.tests.map((t, index) => ({ ...t, story: si, index })).filter(t => (t.steps || []).includes(step.id));
    const tests = covering.length
      ? `<div class="tests">${covering.map(t => `<button class="btn" data-a="test" data-story="${si}" data-i="${t.index}" title="${esc(t.file)}">Test: <span class="mono">${esc(t.name)}</span></button>`).join('')}</div>`
      : untested(story, step) ? '<div class="warn small">No test listed for this step.</div>' : '';
    const others = stepFlags(story, si, i).filter(f => f.cls === 'muted');
    return `<section class="card step selected" id="step-${i}">
      <div class="step-head">
        <span class="num${step.removed ? ' removed' : step.changed ? ' changed' : ''}">${i + 1}</span>
        <h2 class="mono${step.removed ? ' struck' : ''}">${esc(step.name)}</h2>
        <span class="chip${step.removed ? ' removed' : step.changed ? ' changed' : ''}">${esc(stepStatus(step, i))}</span>
      </div>
      <div class="mono muted small">${esc(step.file)}${step.removed ? '' : `:${step.focusLine}`}${others.length ? ` · ${esc(others[0].text)}` : ''}</div>
      ${step.summary ? `<div>${esc(step.summary)}</div>` : ''}
      ${notes.join('')}
      <div class="code">${excerpt(step, i, info)}</div>
      ${tests}
      ${sample(step)}
      <div class="actions">
        ${step.changed && !step.removed ? `<button class="btn" data-a="diff" data-i="${i}">Open diff in editor</button>` : ''}
        <button class="btn" data-a="file" data-i="${i}">${step.removed ? 'Open removed code' : 'Open file in editor'}</button>
      </div>
    </section>`;
  }

  function stepsTab(s, si) {
    return `<div class="stepnav">
        <span class="strong">Step ${state.stepIndex + 1} of ${s.steps.length}</span>
        <div class="pager">
          <button class="btn" data-a="move" data-d="-1" ${state.stepIndex === 0 ? 'disabled' : ''}>Previous step</button>
          <button class="btn" data-a="move" data-d="1" ${state.stepIndex === s.steps.length - 1 ? 'disabled' : ''}>Next step</button>
        </div>
      </div>
      <div class="steps">${s.steps.map((step, i) => (i === state.stepIndex ? stepCard(s, si, step, i) : stepRow(s, si, step, i))).join('')}</div>
      <div class="muted small">Click a line to open the file there. To comment, select lines in the editor and use the plus in the gutter.</div>`;
  }

  function risksTab(s) {
    if (!s.risks.length) {
      return '<div class="muted">The author of this change flagged nothing in this story.</div>';
    }
    const rows = s.risks.map(r => {
      const i = s.steps.findIndex(x => x.id === r.step);
      return `<div class="risk"><span>${esc(r.text)}</span>${i >= 0 ? `<button class="btn" data-a="step" data-i="${i}" title="${esc(s.steps[i].name)}">Step ${i + 1}</button>` : ''}</div>`;
    });
    return `${rows.join('')}
      <div class="muted small">Written by the agent that made the change: the places it was least sure about. These are pointers, not a verdict.</div>`;
  }

  function storyTestsTab(s, si) {
    const gaps = s.steps.map((step, i) => (untested(s, step) ? `<div class="warn small">No test covers step ${i + 1}, ${esc(step.name)}.</div>` : '')).join('');
    if (!s.tests.length) {
      return '<div class="warn">No test is listed for this story.</div>';
    }
    const rows = s.tests.map((t, index) => {
      const steps = (t.steps || []).map(id => s.steps.findIndex(x => x.id === id) + 1).filter(n => n > 0);
      const covers = steps.length ? ` · covers step${steps.length === 1 ? '' : 's'} ${steps.join(', ')}` : '';
      return testRow({ ...t, story: si, index }, `${esc(t.file)}${t.line ? `:${t.line}` : ''}${covers}`);
    });
    return `<div class="list">${rows.join('')}</div>${gaps}`;
  }

  function story(doc) {
    const si = state.storyIndex;
    const s = doc.stories[si];
    const count = doc.stories.length;
    const status = insight(si).status;
    const facts = storyFacts(s, si);
    const files = new Set(s.steps.map(x => x.file));
    const comments = state.comments.filter(c => files.has(c.file));
    const tab = local.storyTab;
    const panel = tab === 'risks' ? risksTab(s) : tab === 'tests' ? storyTestsTab(s, si) : tab === 'diagram' ? sequence(s) : tab === 'comments' ? commentsSection(comments) : stepsTab(s, si);
    const since = status === 'changed'
      ? `<div class="notice accent"><span class="strong">Changed since you reviewed it${insight(si).reviewedAt ? ` on ${esc(new Date(insight(si).reviewedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}` : ''}.</span> The steps that changed are marked. The rest are the same as when you read them.</div>`
      : '';
    const before = [
      facts.stale ? `${plural(facts.stale, 'step is', 'steps are')} out of date` : '',
      facts.hidden ? `${plural(facts.hidden, 'changed line is', 'changed lines are')} not shown in its steps` : ''
    ].filter(Boolean);
    const label = status === 'reviewed' ? 'Reviewed. Mark as not reviewed' : status === 'changed' ? 'Mark reviewed again' : nextLabel(doc);
    return `<div class="page">
      <div class="topbar">
        <button class="btn" data-a="overview">${ICON.left}Overview</button>
        <div class="pager">
          <button class="btn icon" data-a="story" data-i="${si - 1}" aria-label="Previous story" ${si === 0 ? 'disabled' : ''}>${ICON.left}</button>
          <span class="muted small">Story ${si + 1} of ${count}</span>
          <button class="btn icon" data-a="story" data-i="${si + 1}" aria-label="Next story" ${si === count - 1 ? 'disabled' : ''}>${ICON.right}</button>
        </div>
      </div>
      <div>
        <h1>${esc(s.title)}</h1>
        <p class="muted">${esc(s.goal)}</p>
        ${s.entryPoint ? `<div class="muted small">Entry point <span class="mono">${esc(s.entryPoint)}</span></div>` : ''}
      </div>
      ${since}
      ${tabs('storyTab', [
        { id: 'steps', label: 'Steps', count: s.steps.length },
        { id: 'risks', label: 'Look closely', count: s.risks.length, warn: s.risks.length > 0 },
        { id: 'tests', label: 'Tests', count: s.tests.length, warn: !s.tests.length },
        { id: 'diagram', label: 'Diagram' },
        { id: 'comments', label: 'Comments', count: comments.length }
      ], tab)}
      <div class="section" role="tabpanel">${panel}</div>
      ${before.length && status !== 'reviewed' ? `<div class="notice warn">Before you mark this reviewed: ${before.join(', and ')}.</div>` : ''}
      <button class="btn ${status === 'reviewed' ? '' : 'primary '}wide" data-a="reviewed">${ICON.check}${label}</button>
    </div>`;
  }

  function nextLabel(doc) {
    const next = doc.stories.findIndex((s, i) => i !== state.storyIndex && insight(i).status !== 'reviewed');
    return next >= 0 ? `Mark reviewed and go to story ${next + 1}` : 'Mark story reviewed';
  }

  // --- comments ---------------------------------------------------------------------------------

  function commentsSection(comments) {
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
    const list = comments.length
      ? `<div class="list">${comments.map(c => `<button class="row comment" data-a="comment" data-id="${esc(c.id)}">
          <span class="comment-head"><span class="mono small">${esc(c.where)}</span><span class="small status ${esc(c.status)}">${esc(c.statusLabel)}</span></span>
          <span class="clip">${esc(c.first)}</span>
        </button>`).join('')}</div>`
      : '<div class="muted small">No comments here yet. To comment, select lines in the editor and use the plus in the gutter.</div>';
    return `${link}${handoff}${list}`;
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

  function banners() {
    const foreign = state.foreign
      ? `<div class="banner">You are on branch <span class="mono">${esc(state.foreign.branch)}</span>. These stories were written for <span class="mono">${esc(state.foreign.writtenFor)}</span>.</div>`
      : '';
    let stale = '';
    if (state.staleSteps) {
      stale = `<div class="banner split"><span><span class="strong">${plural(state.staleSteps, 'step shows', 'steps show')} old code.</span> Files were edited after the stories were written. Ask your agent to refresh them.</span>${copyButton(state.refreshPrompt)}</div>`;
    } else if (state.stale) {
      stale = '<div class="banner">New commits were made since these stories were written. The steps still match the code.</div>';
    }
    return foreign + stale;
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
      if (last.story !== state.storyIndex && last.view === 'story' && state.view === 'story') {
        local.storyTab = 'steps';
      }
      html = banners() + (state.view === 'story' ? story(state.doc) : overview(state.doc));
    }
    root.innerHTML = html;
    const tab = state.view === 'story' ? local.storyTab : local.tab;
    const samePage = last.view === state.view && last.story === state.storyIndex && last.tab === tab;
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
    last = { view: state.view, story: state.storyIndex, step: state.stepIndex, tab };
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
      case 'tab':
        local.tab = d.tab;
        return render();
      case 'storyTab':
        local.storyTab = d.tab;
        return render();
      case 'story':
        local.storyTab = 'steps';
        return post({ type: 'openStory', index: Number(d.i) });
      case 'overview': return post({ type: 'overview' });
      case 'step':
        // A step opened from the diagram or from "Look closely" is read in the steps list.
        local.storyTab = 'steps';
        return post({ type: 'step', index: Number(d.i), line: d.line ? Number(d.line) : undefined });
      case 'move': return post({ type: 'moveStep', delta: Number(d.d) });
      case 'diff': return post({ type: 'openDiff', index: Number(d.i) });
      case 'file': return post({ type: 'openFile', index: Number(d.i) });
      case 'reviewed': return post({ type: 'toggleReviewed' });
      case 'deleteSet': return post({ type: 'deleteSet' });
      case 'unstoriedFile': return post({ type: 'openUnstoried', path: d.path });
      case 'lines': return post({ type: 'openLines', path: d.path, line: Number(d.line) });
      case 'test': return post({ type: 'openTest', story: Number(d.story), index: Number(d.i) });
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
      case 'copySummary':
        post({ type: 'copySummary' });
        local.copied = '#summary';
        return render();
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
