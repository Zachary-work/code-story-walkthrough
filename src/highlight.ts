import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { Step } from './core/model';

/** A run of text in one colour: [text, colour or null, style]. Style: 1 italic, 2 bold. */
export type Span = [string, string | null, number];

/** The colours of one step's lines, for the story panel. `lines[i]` is undefined when a line has none. */
export interface StepColours {
  story: number;
  step: number;
  lines: (Span[] | null)[];
}

type ThemeSettings = textmate.IRawTheme['settings'];

interface GrammarEntry {
  scopeName: string;
  file: string;
  language?: string;
}

/**
 * Colours the code of a step the way the editor does: with the grammars of the installed
 * language extensions and the colours of the active theme. VS Code has no API that returns an
 * editor's token colours, so this reads the same grammar and theme files that the editor reads.
 * Semantic colours from a language server are not included.
 */
export class StepHighlighter implements vscode.Disposable {
  private registry?: Promise<textmate.Registry | undefined>;
  private colours: string[] = [];
  private grammars = new Map<string, GrammarEntry>();
  private languages = new Map<string, string>();
  private byExtension = new Map<string, string>();
  private wasm?: Promise<void>;
  private readonly cache = new Map<string, Span[][]>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly root: string, onChange: () => void) {
    const reset = () => {
      this.registry = undefined;
      this.cache.clear();
      onChange();
    };
    this.subscriptions = [
      vscode.window.onDidChangeActiveColorTheme(reset),
      vscode.extensions.onDidChange(reset),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.colorTheme')) {
          reset();
        }
      })
    ];
  }

  dispose(): void {
    this.subscriptions.forEach(s => s.dispose());
  }

  /** The colours for one step, or undefined when the editor's grammar or theme cannot be used. */
  async colour(story: number, index: number, step: Step): Promise<StepColours | undefined> {
    try {
      const registry = await (this.registry ??= this.load());
      if (!registry) {
        return undefined;
      }
      const uri = vscode.Uri.file(path.join(this.root, step.file));
      let document: vscode.TextDocument | undefined;
      if (!step.removed) {
        try {
          document = await vscode.workspace.openTextDocument(uri);
        } catch {
          document = undefined;
        }
      }
      const language = document?.languageId ?? this.byExtension.get(path.extname(step.file).toLowerCase());
      const scope = language && this.languages.get(language);
      const grammar = scope ? await registry.loadGrammar(scope) : null;
      if (!grammar) {
        return undefined;
      }
      // The file as the editor has it, coloured from its first line down to the last line the step shows.
      let fromFile: Span[][] = [];
      if (document) {
        const last = Math.max(0, ...step.lines.map(l => l.line ?? 0));
        const key = `${uri.toString()}@${document.version}`;
        fromFile = this.cache.get(key) ?? [];
        if (fromFile.length < last) {
          fromFile = this.tokenize(grammar, Array.from({ length: Math.min(last, document.lineCount) }, (_, n) => document!.lineAt(n).text));
          this.cache.clear();
          this.cache.set(key, fromFile);
        }
      }
      const lines = step.lines.map(l => {
        const inFile = l.line && document && l.line <= document.lineCount ? document.lineAt(l.line - 1).text : undefined;
        if (inFile !== undefined && inFile.trim() === l.text.trim()) {
          return reindent(fromFile[l.line! - 1], inFile, l.text);
        }
        // A removed line, or a line that no longer matches the file: colour it by itself.
        return this.tokenize(grammar, [l.text])[0];
      });
      return { story, step: index, lines };
    } catch {
      return undefined;
    }
  }

  private tokenize(grammar: textmate.IGrammar, lines: string[]): Span[][] {
    let stack = textmate.INITIAL;
    return lines.map(text => {
      // Very long lines are slow to tokenize and are not code a reviewer reads.
      if (text.length > 2000) {
        return [[text, null, 0] as Span];
      }
      const result = grammar.tokenizeLine2(text, stack);
      stack = result.ruleStack;
      const spans: Span[] = [];
      for (let i = 0; i < result.tokens.length; i += 2) {
        const start = result.tokens[i];
        const end = i + 2 < result.tokens.length ? result.tokens[i + 2] : text.length;
        const meta = result.tokens[i + 1];
        // Colour 1 is the theme's plain text colour. The panel has its own, so leave such text uncoloured.
        const id = (meta >>> 15) & 0x1ff;
        const colour = id === 1 ? null : this.colours[id] ?? null;
        const font = (meta >>> 11) & 0xf;
        const style = (font & 1 ? 1 : 0) | (font & 2 ? 2 : 0);
        const previous = spans[spans.length - 1];
        if (previous && previous[1] === colour && previous[2] === style) {
          previous[0] += text.slice(start, end);
        } else if (end > start) {
          spans.push([text.slice(start, end), colour, style]);
        }
      }
      return spans;
    });
  }

  /** Reads the grammars of the installed extensions and the active theme. */
  private async load(): Promise<textmate.Registry | undefined> {
    this.grammars.clear();
    this.languages.clear();
    this.byExtension.clear();
    let theme: { file: string } | undefined;
    const wanted = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    for (const extension of vscode.extensions.all) {
      const contributes = extension.packageJSON?.contributes;
      for (const g of contributes?.grammars ?? []) {
        if (g.scopeName && g.path) {
          this.grammars.set(g.scopeName, { scopeName: g.scopeName, file: path.join(extension.extensionPath, g.path), language: g.language });
          if (g.language && !this.languages.has(g.language)) {
            this.languages.set(g.language, g.scopeName);
          }
        }
      }
      for (const l of contributes?.languages ?? []) {
        for (const ext of l.extensions ?? []) {
          if (l.id && !this.byExtension.has(String(ext).toLowerCase())) {
            this.byExtension.set(String(ext).toLowerCase(), l.id);
          }
        }
      }
      for (const t of contributes?.themes ?? []) {
        // Older settings name the built-in themes with "Default " in front.
        if (t.path && [t.id, t.label].some(name => name && String(name).replace(/^Default /, '') === String(wanted ?? '').replace(/^Default /, ''))) {
          theme = { file: path.join(extension.extensionPath, t.path) };
        }
      }
    }
    if (!theme) {
      return undefined;
    }
    const settings = readTheme(theme.file);
    if (!settings) {
      return undefined;
    }
    await (this.wasm ??= oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer as ArrayBuffer));
    const registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: sources => new oniguruma.OnigScanner(sources),
        createOnigString: text => new oniguruma.OnigString(text)
      }),
      loadGrammar: async scopeName => {
        const entry = this.grammars.get(scopeName);
        if (!entry) {
          return null;
        }
        return textmate.parseRawGrammar(await fs.promises.readFile(entry.file, 'utf8'), entry.file);
      }
    });
    registry.setTheme({ name: wanted, settings });
    this.colours = registry.getColorMap();
    return registry;
  }
}

/** A theme's token colours, with the themes it includes; undefined for a format this does not read. */
function readTheme(file: string, depth = 0): ThemeSettings | undefined {
  if (depth > 5 || !file.toLowerCase().endsWith('.json')) {
    return undefined;
  }
  const theme = parseJsonc(fs.readFileSync(file, 'utf8')) as { include?: string; tokenColors?: unknown; colors?: Record<string, string> } | undefined;
  if (!theme) {
    return undefined;
  }
  const base = theme.include ? readTheme(path.join(path.dirname(file), theme.include), depth + 1) ?? [] : [];
  if (typeof theme.tokenColors === 'string') {
    // The token colours are in a separate .tmTheme file, which this does not read.
    return base.length ? base : undefined;
  }
  const own = Array.isArray(theme.tokenColors) ? (theme.tokenColors as ThemeSettings) : [];
  const foreground = theme.colors?.['editor.foreground'];
  return [...(foreground ? [{ settings: { foreground } }] : []), ...base, ...own];
}

/** The colours of a file line, moved onto the story's copy of it, which can have other indentation. */
function reindent(spans: Span[] | undefined, inFile: string, text: string): Span[] | null {
  if (!spans) {
    return null;
  }
  const lead = inFile.length - inFile.trimStart().length;
  const out: Span[] = [];
  let at = 0;
  for (const [piece, colour, style] of spans) {
    const from = Math.max(at, lead);
    const end = at + piece.length;
    at = end;
    if (end > from) {
      out.push([inFile.slice(from, end), colour, style]);
    }
  }
  const indent = text.slice(0, text.length - text.trimStart().length);
  const body = out.map(s => s[0]).join('');
  if (body.trimEnd() !== text.trimStart().trimEnd()) {
    return null;
  }
  return indent ? [[indent, null, 0], ...out] : out;
}
