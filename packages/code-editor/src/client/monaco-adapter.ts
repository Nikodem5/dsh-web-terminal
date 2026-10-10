// dsh-code-editor - the real editor: Monaco (lite variant) behind the EditorHost interface.
// Imported dynamically, so Monaco only EXECUTES when the Code page first opens.

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution'
import 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution'
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution'
import 'monaco-editor/esm/vs/basic-languages/php/php.contribution'
import 'monaco-editor/esm/vs/basic-languages/lua/lua.contribution'
import 'monaco-editor/esm/vs/basic-languages/swift/swift.contribution'
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution'
// @ts-expect-error virtual module provided by build.mjs (the editor web worker as a string)
import EDITOR_WORKER from 'ce-worker:editor'
// @ts-expect-error virtual module provided by build.mjs (Monaco CSS with the codicon font inlined)
import CSS_TEXT from 'ce-css:all'
import type { AdapterFactory, EditorHost, Position } from './adapter.ts'

declare const __MONACO_VERSION__: string
export const MONACO_VERSION = __MONACO_VERSION__

function probe(make: () => Worker): Promise<boolean> {
  return new Promise((resolve) => {
    let w: Worker
    try { w = make() } catch { resolve(false); return }
    const t = setTimeout(() => done(false), 2000)
    const done = (ok: boolean): void => { clearTimeout(t); try { w.terminate() } catch { /* ignore */ } resolve(ok) }
    w.onmessage = () => done(true)
    w.onerror = () => done(false)
    w.postMessage(0)
  })
}

let envReady: Promise<void> | null = null
/** Style tag + worker strategy (blob URL, else data: URL, else Monaco's main-thread fallback). Once. */
function setupEnvironment(): Promise<void> {
  if (envReady) return envReady
  envReady = (async () => {
    const style = document.createElement('style')
    style.dataset.dshCodeEditor = 'monaco'
    style.textContent = CSS_TEXT
    document.head.appendChild(style)
    const probeSrc = 'onmessage=function(){postMessage(1)}'
    const blobUrl = (code: string): string => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const dataUrl = (code: string): string => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code)
    const make = (await probe(() => new Worker(blobUrl(probeSrc)))) ? blobUrl : (await probe(() => new Worker(dataUrl(probeSrc)))) ? dataUrl : null
    if (make) (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new Worker(make(EDITOR_WORKER)) }
    registerJson()
    defineThemes()
  })()
  return envReady
}

/** JSON highlighting without the JSON language service (lite variant): a small Monarch grammar. */
function registerJson(): void {
  if (monaco.languages.getLanguages().some((l) => l.id === 'json')) return
  monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'], aliases: ['JSON', 'json'], mimetypes: ['application/json'] })
  monaco.languages.setLanguageConfiguration('json', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}', notIn: ['string'] }, { open: '[', close: ']', notIn: ['string'] }, { open: '"', close: '"', notIn: ['string'] }],
  })
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/[{}[\],:]/, 'delimiter'],
      ],
      comment: [[/[^*/]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[*/]/, 'comment']],
    },
  } as monaco.languages.IMonarchLanguage)
}

function defineThemes(): void {
  monaco.editor.defineTheme('dsh-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#14161b', 'editorGutter.background': '#14161b', 'minimap.background': '#14161b' } })
  monaco.editor.defineTheme('dsh-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } })
}

interface FileModel { model: monaco.editor.ITextModel; view: monaco.editor.ICodeEditorViewState | null }
interface DiffModels { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel }

class MonacoHost implements EditorHost {
  readonly element: HTMLElement
  private edEl: HTMLElement
  private diffEl: HTMLElement
  private editor: monaco.editor.IStandaloneCodeEditor
  private diff: monaco.editor.IStandaloneDiffEditor
  private files = new Map<string, FileModel>()
  private diffs = new Map<string, DiffModels>()
  private currentFile: string | null = null
  private currentDiff: string | null = null
  private changeCb: (id: string) => void = () => {}
  private cursorCb: (p: Position) => void = () => {}
  private keyCb: (a: 'save' | 'quickOpen' | 'closeTab') => void = () => {}

  constructor(dark: boolean) {
    this.element = document.createElement('div')
    this.element.className = 'ce-monaco'
    this.edEl = document.createElement('div')
    this.diffEl = document.createElement('div')
    this.edEl.className = 'ce-ed'
    this.diffEl.className = 'ce-ed'
    this.diffEl.style.display = 'none'
    this.element.append(this.edEl, this.diffEl)
    monaco.editor.setTheme(dark ? 'dsh-dark' : 'dsh-light')
    this.editor = monaco.editor.create(this.edEl, {
      model: null, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
      renderWhitespace: 'selection', fixedOverflowWidgets: true, smoothScrolling: true, padding: { top: 6 },
    })
    this.diff = monaco.editor.createDiffEditor(this.diffEl, {
      automaticLayout: true, renderSideBySide: true, originalEditable: false, readOnly: true, fixedOverflowWidgets: true,
      minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, ignoreTrimWhitespace: false,
    })
    const bind = (ed: monaco.editor.ICodeEditor): void => {
      const { KeyMod, KeyCode } = monaco
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => this.keyCb('save'))
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, () => this.keyCb('quickOpen'))
      ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyW, () => this.keyCb('closeTab'))
    }
    bind(this.editor)
    bind(this.diff.getModifiedEditor())
    bind(this.diff.getOriginalEditor())
    this.editor.onDidChangeCursorPosition((e) => this.cursorCb({ line: e.position.lineNumber, col: e.position.column }))
    this.diff.getModifiedEditor().onDidChangeCursorPosition((e) => this.cursorCb({ line: e.position.lineNumber, col: e.position.column }))
  }

  private saveView(): void {
    if (this.currentFile) {
      const f = this.files.get(this.currentFile)
      if (f) f.view = this.editor.saveViewState()
    }
  }

  showFile(id: string, text: string, language: string, readOnly: boolean): string {
    this.saveView()
    let f = this.files.get(id)
    if (!f) {
      const model = monaco.editor.createModel(text, language, monaco.Uri.from({ scheme: 'dshce', path: `/file/${encodeURIComponent(id)}` }))
      model.onDidChangeContent(() => this.changeCb(id))
      f = { model, view: null }
      this.files.set(id, f)
    }
    this.currentFile = id
    this.currentDiff = null
    this.diffEl.style.display = 'none'
    this.edEl.style.display = ''
    this.editor.updateOptions({ readOnly })
    this.editor.setModel(f.model)
    if (f.view) this.editor.restoreViewState(f.view)
    const p = this.editor.getPosition()
    if (p) this.cursorCb({ line: p.lineNumber, col: p.column })
    this.editor.layout()
    return f.model.getValue()
  }

  showDiff(id: string, original: string, modified: string, language: string, inline: boolean): void {
    this.saveView()
    this.currentFile = null
    let d = this.diffs.get(id)
    if (!d) {
      const uri = (side: string): monaco.Uri => monaco.Uri.from({ scheme: 'dshce', path: `/diff/${side}/${encodeURIComponent(id)}` })
      d = { original: monaco.editor.createModel(original, language, uri('a')), modified: monaco.editor.createModel(modified, language, uri('b')) }
      this.diffs.set(id, d)
    } else {
      if (d.original.getValue() !== original) d.original.setValue(original)
      if (d.modified.getValue() !== modified) d.modified.setValue(modified)
    }
    this.currentDiff = id
    this.edEl.style.display = 'none'
    this.diffEl.style.display = ''
    this.diff.updateOptions({ renderSideBySide: !inline })
    this.diff.setModel(d)
    this.diff.layout()
  }

  showNone(): void {
    this.saveView()
    this.currentFile = null
    this.currentDiff = null
    this.editor.setModel(null)
    this.diff.setModel(null)
  }

  getValue(id: string): string | null { return this.files.get(id)?.model.getValue() ?? null }
  hasModel(id: string): boolean { return this.files.has(id) }
  getEol(id: string): 'lf' | 'crlf' { return this.files.get(id)?.model.getEOL() === '\r\n' ? 'crlf' : 'lf' }

  setValue(id: string, text: string): boolean {
    const f = this.files.get(id)
    if (!f) return false
    const active = this.currentFile === id
    const view = active ? this.editor.saveViewState() : f.view
    f.model.setValue(text)
    if (active && view) this.editor.restoreViewState(view)
    else f.view = view
    return true
  }

  disposeModel(id: string): void {
    const f = this.files.get(id)
    if (f) {
      if (this.currentFile === id) { this.editor.setModel(null); this.currentFile = null }
      f.model.dispose()
      this.files.delete(id)
    }
    const d = this.diffs.get(id)
    if (d) {
      if (this.currentDiff === id) { this.diff.setModel(null); this.currentDiff = null }
      d.original.dispose()
      d.modified.dispose()
      this.diffs.delete(id)
    }
  }

  reveal(line: number, col: number): void {
    const ed = this.currentFile ? this.editor : this.diff.getModifiedEditor()
    ed.setPosition({ lineNumber: line, column: col })
    ed.revealLineInCenter(line)
    ed.focus()
  }

  setTheme(dark: boolean): void { monaco.editor.setTheme(dark ? 'dsh-dark' : 'dsh-light') }
  setInline(inline: boolean): void { this.diff.updateOptions({ renderSideBySide: !inline }) }
  layout(): void { this.editor.layout(); this.diff.layout() }
  focus(): void { (this.currentFile ? this.editor : this.diff.getModifiedEditor()).focus() }
  onChange(cb: (id: string) => void): void { this.changeCb = cb }
  onCursor(cb: (p: Position) => void): void { this.cursorCb = cb }
  onKey(cb: (a: 'save' | 'quickOpen' | 'closeTab') => void): void { this.keyCb = cb }

  dispose(): void {
    try {
      this.diff.setModel(null)
      this.editor.setModel(null)
      this.diff.dispose()
      this.editor.dispose()
      for (const f of this.files.values()) f.model.dispose()
      for (const d of this.diffs.values()) { d.original.dispose(); d.modified.dispose() }
    } catch { /* ignore */ }
    this.files.clear()
    this.diffs.clear()
    this.element.remove()
  }
}

export const factory: AdapterFactory = {
  async create({ dark }) {
    await setupEnvironment()
    return new MonacoHost(dark)
  },
}
