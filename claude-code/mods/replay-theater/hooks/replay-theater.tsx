// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater: records the file edits Claude makes in a turn, then lets you
// step through them in a pane, one diff at a time. It joins the /mods panel as
// `$.replay`, whose `open` action opens the pane, and lists every component it
// draws in the panel's Components tab through `$.replay.catalog`.
//
// Drawn with the pack's shared kit (hooks/kit), in the colours of the skin
// chosen in skins, or Claude Code's own without it. The diff itself is the
// engine's `Code` element, so it reads like Claude Code's own edit diffs.

import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import { action, empty, group, icon, kitOf, staticTree, text } from './kit/kit'
import type { Kit, KitUi } from './kit/kit'
import { toneOf } from './kit/tone'
import type { KitSkin } from './kit/tone'
import type { ReplayActArgs, ReplayActResult, ReplayCatalogEntry, ReplayPanel, ReplayPanelArgs } from '../types'

const PANE_ID = 'replay-theater'
const MAX_DIFF_LINES = 12
const MAX_LCS_LINES = 400
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

// One line of a step's diff: the op, the text, and the old (`a`) and new (`b`)
// line numbers at that point. `gap` marks the first line after a skipped run.
type Op = ' ' | '+' | '-'
type DiffLine = { op: Op; t: string; a: number; b: number; gap?: true }

// One step of the replay: a tool, the file, the line diff and a short note.
type Step = { tool: string; file: string; diff: DiffLine[]; note: string }

// Module state. `pending` fills during a turn; `replay` is the last finished
// turn's steps, the ones the pane shows.
const state = { pending: [] as Step[], replay: [] as Step[], index: 0, isOpen: false, inBand: false, turns: 0 }

function relPath(cwd: string, path: string | undefined): string {
  if (!path) return '(unknown file)'
  if (cwd && path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  return path
}

function splitLines(text: unknown): string[] {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// A line diff, numbered from `start` (the old text's first line in its file).
// Small inputs get an LCS diff, so unchanged lines show as context; large ones
// fall back to all-removed then all-added.
function diffLines(oldText: unknown, newText: unknown, start = 1): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  const push = (op: Op, t: string) => out.push({ op, t, a: start + i, b: start + j })
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    for (; i < a.length; i++) push('-', a[i]!)
    for (; j < b.length; j++) push('+', b[j]!)
    return out
  }
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let x = n - 1; x >= 0; x--)
    for (let y = m - 1; y >= 0; y--) dp[x]![y] = a[x] === b[y] ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!)
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(' ', a[i]!)
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push('-', a[i]!)
      i++
    } else {
      push('+', b[j]!)
      j++
    }
  }
  for (; i < n; i++) push('-', a[i]!)
  for (; j < m; j++) push('+', b[j]!)
  return trimContext(out)
}

// Keep one line of context around each change, so a long file's Write shows
// the changed lines, not the whole file. A skipped run starts a new hunk.
function trimContext(lines: DiffLine[]): DiffLine[] {
  if (!lines.some(l => l.op !== ' ')) return lines.slice(0, MAX_DIFF_LINES)
  const changed = (k: number) => lines[k] !== undefined && lines[k]!.op !== ' '
  const out: DiffLine[] = []
  let skipped = false
  lines.forEach((l, k) => {
    if (changed(k) || changed(k - 1) || changed(k + 1)) {
      out.push(skipped && out.length ? { ...l, gap: true } : l)
      skipped = false
    } else skipped = true
  })
  return out
}

function countChanges(diff: DiffLine[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const l of diff) {
    if (l.op === '+') add++
    else if (l.op === '-') del++
  }
  return { add, del }
}

function makeStep(tool: string, file: string, oldText: unknown, newText: unknown, note: string, start = 1): Step {
  return { tool, file, diff: diffLines(oldText, newText, start), note }
}

// The 1-based line `needle` starts on in `text`, or 1 when it isn't there.
function lineOf(text: string, needle: string): number {
  const at = needle ? text.indexOf(needle) : -1
  return at < 0 ? 1 : text.slice(0, at).split('\n').length
}

// The file as it is before the call, or null when it can't be read.
async function readBefore($: EngineInterface, path: string | undefined): Promise<string | null> {
  try {
    if (path && (await $.fs.exists(path))) return String(await $.fs.read(path))
  } catch {
    // unreadable: no line numbers
  }
  return null
}

type EditArgs = { old_string?: string; new_string?: string; replace_all?: boolean }

// Turns one tool call into one or more steps. Edits are numbered by where they
// land in the file as it stands before the call; a MultiEdit's edits apply in
// order, each found in the text the earlier ones left.
async function stepsFor($: EngineInterface, e: { tool: string; file_path?: string; content?: string; edits?: EditArgs[] } & EditArgs): Promise<Step[]> {
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    // keep the full path
  }
  const file = relPath(cwd, e.file_path)
  if (e.tool === 'Edit') {
    const before = await readBefore($, e.file_path)
    const start = before === null ? 1 : lineOf(before, e.old_string ?? '')
    return [makeStep('Edit', file, e.old_string, e.new_string, e.replace_all ? 'replace all' : '', start)]
  }
  if (e.tool === 'MultiEdit' && Array.isArray(e.edits)) {
    let text = await readBefore($, e.file_path)
    return e.edits.map((ed, k) => {
      const start = text === null ? 1 : lineOf(text, ed.old_string ?? '')
      if (text !== null && ed.old_string) text = ed.replace_all ? text.split(ed.old_string).join(ed.new_string ?? '') : text.replace(ed.old_string, () => ed.new_string ?? '')
      return makeStep('MultiEdit', file, ed.old_string, ed.new_string, `edit ${k + 1} of ${e.edits!.length}`, start)
    })
  }
  if (e.tool === 'Write') {
    const before = await readBefore($, e.file_path)
    return [makeStep('Write', file, before ?? '', e.content, before === null ? 'new file' : 'rewrite')]
  }
  return []
}

// The skin every mod wears, from skins; Claude Code's own colours without it.
async function skinOf($: EngineInterface): Promise<KitSkin | null> {
  try {
    return await $.skins.palette()
  } catch {
    return null // skins not installed: Claude Code's own colours
  }
}

async function openReplay($: EngineInterface): Promise<boolean> {
  if (!state.replay.length) return false
  state.index = 0
  state.isOpen = true
  // The pane only takes the keyboard while nothing else holds it. Hide the
  // band first (it held the keys if its button was pressed), then open.
  $.ui.invalidate('ui.render')
  await $.clock.sleep(200)
  const placed = await $.ui.open({ id: PANE_ID, title: 'Replay Theater', focus: true, closeOnEscape: true, rows: 24, columns: 64 })
  // No room for a pane (a narrow terminal): draw the replay in the band.
  state.inBand = placed?.isPlaced === false
  $.ui.invalidate('ui.render')
  return true
}

// ---- Drawing --------------------------------------------------------------
//
// Each builder takes a kit (the element table, the tone, the surface) and plain
// data, so the pane, the band and the /mods catalog all draw from the same code.

type Child = RenderElement | string | null | undefined | false

// The band's diff cap: what fits in the rows the band may take.
function bandDiffLines(maxRows: number | undefined): number {
  return Math.max(3, Math.min(MAX_DIFF_LINES, (maxRows || 20) - 7))
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// The band above the prompt after a turn with edits: the count and the Replay
// button, the band's one action, on the hotkey r.
function hintTree(k: Kit, n: number, onOpen: () => void): RenderElement {
  const { Box } = k.ui
  return (
    <Box key="hint" flexDirection="row" columnGap={1} paddingX={1} alignItems="center" flexWrap="wrap">
      {icon(k, 'replay', 'accent', 16, '▶')}
      {text(k, `${plural(n, 'edit', 'edits')} in the last turn`, undefined, { key: 'hint-count' })}
      {action(k, 'open-replay', 'Replay', onOpen, { primary: true, hotkey: 'r' })}
      {text(k, 'press r', 'faint', { key: 'hint-key' })}
    </Box>
  )
}

// Shown when the pane opens on a turn with nothing recorded.
function emptyTree(k: Kit): RenderElement {
  return empty(k, 'no-edits', 'No edits to replay.', "Claude's file edits in a turn show here, one diff at a time.")
}

// Previous, Next and Close, on the hotkeys p, n and c, with the step icons
// beside them on the desktop. Next is the main action until the last step,
// where Close takes the accent; a press that can't move is drawn dim.
function navButtons(k: Kit, index: number, total: number, onPrev: () => void, onNext: () => void, onClose: () => void): RenderElement {
  const { Box, Button } = k.ui
  const first = index <= 0
  const last = index >= total - 1
  return (
    <Box key="nav" flexDirection="row" columnGap={1} alignItems="center" flexShrink={0}>
      {icon(k, 'stepBack', 'muted', 14)}
      <Button key="prev" label="Previous" hotkey="p" {...(first ? { dimColor: true } : {})} onPress={onPrev} />
      <Button key="next" label="Next" hotkey="n" autoFocus {...(last ? { dimColor: true } : { variant: 'primary' })} onPress={onNext} />
      {icon(k, 'stepForward', 'muted', 14)}
      <Button key="close" label="Close" hotkey="c" {...(last ? { variant: 'primary' } : { dimColor: true })} onPress={onClose} />
    </Box>
  )
}

// The header: where the replay is ("3 of 8") and the buttons.
function headerRow(k: Kit, index: number, total: number, onPrev: () => void, onNext: () => void, onClose: () => void): RenderElement {
  const { Box } = k.ui
  return (
    <Box key="header" flexDirection="row" columnGap={2} rowGap={0} alignItems="center" flexWrap="wrap" paddingX={1}>
      <Box flexGrow={1} flexDirection="row" columnGap={1}>
        {text(k, `${index + 1} of ${total}`, undefined, { bold: true, key: 'position' })}
        {text(k, total === 1 ? 'edit' : 'edits', 'muted')}
      </Box>
      {navButtons(k, index, total, onPrev, onNext, onClose)}
    </Box>
  )
}

// Where the replay is among its steps: a segment per step on the desktop, the
// current one in the accent and the ones seen in the muted tone; numbered cells
// on the terminal, the current one inverted.
function stepStrip(k: Kit, total: number, index: number): RenderElement {
  const { Box, Text, Svg } = k.ui
  if (k.vector) {
    const room = Math.max(120, k.columns * 7 - 16)
    const gap = 3
    const seg = Math.max(4, Math.min(28, Math.floor((room + gap) / total) - gap))
    const width = total * (seg + gap) - gap
    const bars = Array.from({ length: total }, (_, n) => {
      const fill = n === index ? k.t.hex.accent : n < index ? k.t.hex.muted : k.t.hex.line
      return `<rect x="${n * (seg + gap)}" y="0" width="${seg}" height="3" rx="1.5" fill="${fill}"/>`
    }).join('')
    return (
      <Box key="strip" paddingX={1}>
        <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="3" viewBox="0 0 ${width} 3">${bars}</svg>`} alt={`step ${index + 1} of ${total}`} width={width} height={3} />
      </Box>
    )
  }
  const cells = Array.from({ length: total }, (_, n) =>
    n === index ? (
      <Text key={`s${n}`} inverse color={k.t.ink.accent}>{` ${n + 1} `}</Text>
    ) : (
      <Text key={`s${n}`} color={k.t.ink.faint}>{` ${n + 1} `}</Text>
    ),
  )
  return (
    <Box key="strip" flexDirection="row" flexWrap="wrap" paddingX={1}>
      {cells}
    </Box>
  )
}

// A highlighter language for a path, where the extension says it plainly; the
// engine infers the rest from `path`.
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', html: 'html', sql: 'sql',
}

function languageOf(path: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return ext ? LANGUAGES[ext] : undefined
}

// The step's file and what changed in it: the tool's icon, the path,
// the tool and its note, and the added and removed line counts.
function fileRow(k: Kit, step: Step): RenderElement {
  const { Box } = k.ui
  const { add, del } = countChanges(step.diff)
  return (
    <Box key="file" flexDirection="row" columnGap={1} paddingX={1} alignItems="flex-start">
      {icon(k, step.note === 'new file' ? 'file' : 'write', 'muted')}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {text(k, step.file, undefined, { key: 'path', wrap: 'wrap' })}
        {text(k, `${step.tool}${step.note ? ' · ' + step.note : ''}`, 'muted', { key: 'tool' })}
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0}>
        {text(k, `+${add}`, 'ok', { key: 'added' })}
        {text(k, `-${del}`, 'err', { key: 'removed' })}
      </Box>
    </Box>
  )
}

// The shown lines as unified-diff hunks, each with its own `@@` header, a new
// hunk wherever unchanged lines were left out.
function hunksOf(lines: DiffLine[]): string {
  const hunks: DiffLine[][] = []
  for (const l of lines) {
    if (!hunks.length || l.gap) hunks.push([])
    hunks[hunks.length - 1]!.push(l)
  }
  return hunks
    .map(h => {
      const olds = h.filter(l => l.op !== '+').length
      const news = h.filter(l => l.op !== '-').length
      const a = olds ? h[0]!.a : h[0]!.a - 1
      const b = news ? h[0]!.b : h[0]!.b - 1
      return [`@@ -${a},${olds} +${b},${news} @@`, ...h.map(l => `${l.op}${l.t}`)].join('\n')
    })
    .join('\n')
}

// The diff, drawn by the engine's own highlighter in a well: gutters, add and
// remove colouring, the file's language. Capped at `maxDiff` lines with
// "… N more lines" after; a step with no line changes says so.
function diffBlock(k: Kit, step: Step, maxDiff: number, wrap: 'wrap' | 'truncate-end' = 'wrap'): RenderElement {
  const { Box, Code } = k.ui as KitUi & { Code: any }
  if (!step.diff.length) {
    return (
      <Box key="diff" paddingX={1}>
        {text(k, 'No line changes', 'muted', { key: 'no-changes' })}
      </Box>
    )
  }
  const shown = step.diff.slice(0, maxDiff)
  const more = step.diff.length - shown.length
  const language = languageOf(step.file)
  return (
    <Box key="diff" flexDirection="column" paddingX={1}>
      <Box flexDirection="column" backgroundColor={k.t.ink.hover} paddingX={1}>
        <Code key="code" source={hunksOf(shown)} format="diff" path={step.file} {...(language ? { language } : {})} wrap={wrap} />
      </Box>
      {more > 0 ? text(k, `… ${plural(more, 'more line', 'more lines')}`, 'faint', { key: 'more' }) : null}
    </Box>
  )
}

type ReplayArgs = { steps: Step[]; index: number; maxDiff: number; wrap?: 'wrap' | 'truncate-end'; onGo: (to: number) => void; onClose: () => void }

// The replay view: one step at a time. `onGo(to)` moves to a step; `onClose`
// closes it.
function replayTree(k: Kit, { steps, index, maxDiff, wrap, onGo, onClose }: ReplayArgs): RenderElement {
  const total = steps.length
  if (!total) return emptyTree(k)
  const at = Math.max(0, Math.min(index, total - 1))
  const step = steps[at]!
  return (
    <k.ui.Box key="replay" flexDirection="column" rowGap={1}>
      {headerRow(k, at, total, () => onGo(at - 1), () => onGo(at + 1), onClose)}
      {stepStrip(k, total, at)}
      {group(k, 'step', [fileRow(k, step), diffBlock(k, step, maxDiff, wrap)])}
    </k.ui.Box>
  )
}

// The live replay: drawn in the Pane, or in the band above the prompt when the
// surface can't place a pane.
async function replayView($: EngineInterface, e: { surface: RenderSurface; props: { bodyColumns: number; maxRows?: number } }, inBand: boolean): Promise<RenderElement> {
  const go = (to: number) => {
    state.index = Math.max(0, Math.min(to, state.replay.length - 1))
    $.ui.invalidate('ui.render')
  }
  const close = () => {
    state.isOpen = false
    if (!state.inBand) void $.ui.close({ id: PANE_ID })
    state.inBand = false
    $.ui.invalidate('ui.render')
  }
  const k = kitOf($.ui.resolve(e as never) as unknown as KitUi, toneOf(await skinOf($)), e.surface, e.props.bodyColumns || 80)
  return replayTree(k, {
    steps: state.replay,
    index: state.index,
    maxDiff: inBand ? bandDiffLines(e.props.maxRows) : MAX_DIFF_LINES,
    wrap: inBand ? 'truncate-end' : 'wrap',
    onGo: go,
    onClose: close,
  })
}

// ---- The catalog ----------------------------------------------------------
//
// Every component Replay Theater draws, named, for the Components tab of /mods.
// Drawn from the builders above with sample steps, then made static: a press
// cannot cross from the hub to this mod.

const noop = () => {}

// Each tree is made static with the kit's `staticTree`: plain data another mod can draw,
// handlers dropped and each Button drawn as its shape (a round hairline box, the main
// action filled with the accent).

// A turn that renamed greet to welcome: the sample the catalog replays.
function sampleSteps(): Step[] {
  const readme = ['# Greeter', '', 'Says hello.', '', '## Usage', '', '```ts', "greet('Ada')", '```', '', '## License', '', 'MIT']
  const doc = [
    '# welcome()', '', 'Returns a greeting for `name`.', '', '```ts', "welcome('Ada') // 'Welcome, Ada!'", '```', '',
    '## Options', '', '- `name`: who to greet', '- `loud`: shout it', '', '## Since', '', '0.3.0',
  ]
  return [
    makeStep('Edit', 'src/greet.ts', 'export function greet(name: string) {\n  return `Hello, ${name}!`\n}', 'export function welcome(name: string) {\n  return `Welcome, ${name}!`\n}', '', 3),
    makeStep('MultiEdit', 'src/cli.ts', "import { greet } from './greet'", "import { welcome } from './greet'", 'edit 1 of 2', 2),
    makeStep('MultiEdit', 'src/cli.ts', '  console.log(greet(argv[2]))', '  console.log(welcome(argv[2]))', 'edit 2 of 2', 9),
    makeStep('Write', 'docs/welcome.md', '', doc.join('\n'), 'new file'),
    makeStep('Write', 'README.md', readme.join('\n'), ['# Welcomer', ...readme.slice(1, 7), "welcome('Ada')", ...readme.slice(8, 12), 'Apache-2.0'].join('\n'), 'rewrite'),
    makeStep('Write', 'src/.keep', '', '', 'new file'),
    makeStep('Edit', 'test/greet.test.ts', 'greet(', 'welcome(', 'replace all', 14),
  ]
}

const CATALOG_TEXT: Record<string, { en: [string, string]; pt: [string, string] }> = {
  'band-hint': {
    en: ['Replay hint above the prompt', 'After a turn that edited files: the edit count and the Replay button (r).'],
    pt: ['Aviso de replay acima do prompt', 'Depois de um turno com edições: quantas edições e o botão Replay (r).'],
  },
  'pane-first-step': {
    en: ['Replay pane, first step (an Edit)', 'The pane on step 1: position and buttons, step strip, file, counts and the diff.'],
    pt: ['Painel do replay, primeiro passo (um Edit)', 'O painel no passo 1: posição e botões, faixa de passos, arquivo, contagem e o diff.'],
  },
  'pane-multiedit-step': {
    en: ['Replay pane, a MultiEdit step', 'One edit of a MultiEdit, noted as "edit 2 of 2".'],
    pt: ['Painel do replay, passo de MultiEdit', 'Uma edição de um MultiEdit, marcada como "edit 2 of 2".'],
  },
  'pane-write-new-file': {
    en: ['Replay pane, a Write of a new file', 'A new file: every line added, capped at 12 lines then "… N more lines".'],
    pt: ['Painel do replay, Write de arquivo novo', 'Um arquivo novo: todas as linhas adicionadas, até 12 linhas e depois "… N more lines".'],
  },
  'pane-write-rewrite': {
    en: ['Replay pane, a Write that rewrites a file', 'A rewrite: one line of context around each change, each run of changes its own hunk.'],
    pt: ['Painel do replay, Write que reescreve um arquivo', 'Uma reescrita: uma linha de contexto em volta de cada mudança, cada trecho de mudanças num hunk próprio.'],
  },
  'pane-no-line-changes': {
    en: ['Replay pane, a step with no line changes', 'A step whose diff is empty, such as a Write of an empty file.'],
    pt: ['Painel do replay, passo sem mudança de linhas', 'Um passo com diff vazio, como um Write de um arquivo vazio.'],
  },
  'pane-last-step': {
    en: ['Replay pane, last step', 'The last step: Next is dim and Close takes the accent; here an Edit with replace all.'],
    pt: ['Painel do replay, último passo', 'O último passo: Next fica esmaecido e Close ganha o destaque; aqui um Edit com replace all.'],
  },
  'pane-no-edits': {
    en: ['Replay pane, nothing to replay', 'What the pane says when the turn recorded no edits.'],
    pt: ['Painel do replay, nada para rever', 'O que o painel diz quando o turno não registrou edições.'],
  },
  'pane-header': {
    en: ['Pane header', 'Where the replay is ("2 of 7") and the Previous, Next and Close buttons.'],
    pt: ['Cabeçalho do painel', 'Onde o replay está ("2 of 7") e os botões Previous, Next e Close.'],
  },
  'step-strip': {
    en: ['Step strip', 'One segment per edit on the desktop (numbered cells on the terminal), the current one in the accent.'],
    pt: ['Faixa de passos', 'Um segmento por edição no desktop (células numeradas no terminal), a atual em destaque.'],
  },
  'step-file-and-counts': {
    en: ['Step file and counts', 'The file path in mono, the tool and its note, and the added (+) and removed (-) line counts.'],
    pt: ['Arquivo e contagem do passo', 'O caminho do arquivo em mono, a ferramenta e sua nota, e as linhas adicionadas (+) e removidas (-).'],
  },
  'diff-lines': {
    en: ['Diff lines', "Claude Code's own diff drawing: line numbers, added and removed lines, the file's syntax colours."],
    pt: ['Linhas do diff', 'O desenho de diff do próprio Claude Code: números de linha, linhas adicionadas e removidas, as cores da sintaxe do arquivo.'],
  },
  'diff-skipped-run': {
    en: ['Skipped run', 'Unchanged lines between two changes are left out: each side is a hunk of its own, with its line numbers.'],
    pt: ['Trecho pulado', 'As linhas sem mudança entre duas alterações ficam de fora: cada lado é um hunk próprio, com seus números de linha.'],
  },
  'diff-more-lines': {
    en: ['More lines notice', '"… N more lines" under a diff longer than the cap.'],
    pt: ['Aviso de mais linhas', '"… N more lines" embaixo de um diff maior que o limite.'],
  },
  'diff-no-line-changes': {
    en: ['No line changes notice', '"No line changes" for a step with an empty diff.'],
    pt: ['Aviso de nenhuma mudança', '"No line changes" para um passo com diff vazio.'],
  },
  'nav-buttons': {
    en: ['Navigation buttons', 'Previous (p), Next (n, the main action, focused first) and Close (c), with step icons on the desktop.'],
    pt: ['Botões de navegação', 'Previous (p), Next (n, a ação principal, com o foco primeiro) e Close (c), com ícones de passo no desktop.'],
  },
  'band-replay-narrow': {
    en: ['Replay in the band, narrow terminal', "When the terminal can't place a pane (80 columns), the replay draws above the prompt with a shorter diff."],
    pt: ['Replay na faixa, terminal estreito', 'Quando o terminal não consegue abrir um painel (80 colunas), o replay aparece acima do prompt com um diff menor.'],
  },
}

async function catalogOf($: EngineInterface, args: Partial<ReplayPanelArgs> | undefined): Promise<ReplayCatalogEntry[]> {
  const lang = args?.lang === 'pt' ? 'pt' : 'en'
  const surface: RenderSurface = args?.surface ?? 'terminal'
  const columns = Math.max(40, Number(args?.columns) || 80)
  const tone = toneOf(await skinOf($))
  const pane = kitOf($.ui.resolve({ surface, component: 'Pane' } as never) as unknown as KitUi, tone, surface, columns)
  const bandColumns = Math.min(columns, 80)
  const band = kitOf($.ui.resolve({ surface, component: 'AbovePrompt' } as never) as unknown as KitUi, tone, surface, bandColumns)
  const steps = sampleSteps()
  const at = (index: number, k: Kit = pane, maxDiff = MAX_DIFF_LINES, wrap: 'wrap' | 'truncate-end' = 'wrap') => replayTree(k, { steps, index, maxDiff, wrap, onGo: noop, onClose: noop })
  const sized = (tree: Child, k: Kit = pane, width = columns) => (
    <k.ui.Box width={width} flexDirection="column">
      {tree}
    </k.ui.Box>
  )
  const lines = (step: Step, maxDiff = MAX_DIFF_LINES) => sized(diffBlock(pane, step, maxDiff))

  // A gap and an overflow, each on its own, from the sample's diffs.
  const rewrite = steps[4]!
  // The rewrite's first two hunks, whole: the run between them is left out.
  const gapAt = rewrite.diff.findIndex(l => l.gap)
  const nextGap = rewrite.diff.findIndex((l, n) => n > gapAt && l.gap)
  const gap: Step = { ...rewrite, diff: rewrite.diff.slice(0, nextGap < 0 ? undefined : nextGap) }
  const overflow: Step = { ...steps[3]!, diff: steps[3]!.diff.slice(0, 6) }

  const trees: Record<string, RenderElement> = {
    'band-hint': sized(hintTree(band, steps.length, noop), band, columns),
    'pane-first-step': sized(at(0)),
    'pane-multiedit-step': sized(at(2)),
    'pane-write-new-file': sized(at(3)),
    'pane-write-rewrite': sized(at(4)),
    'pane-no-line-changes': sized(at(5)),
    'pane-last-step': sized(at(steps.length - 1)),
    'pane-no-edits': sized(emptyTree(pane)),
    'pane-header': sized(headerRow(pane, 1, steps.length, noop, noop, noop)),
    'step-strip': sized(stepStrip(pane, steps.length, 1)),
    'step-file-and-counts': sized(fileRow(pane, steps[0]!)),
    'diff-lines': lines(steps[0]!),
    'diff-skipped-run': lines(gap),
    'diff-more-lines': lines(overflow, 3),
    'diff-no-line-changes': lines(steps[5]!),
    'nav-buttons': sized(navButtons(pane, 0, steps.length, noop, noop, noop)),
    // A pane always has room on a desktop; only a narrow terminal falls back to
    // the band, where the diff is cut to the rows the band has (5 of 12 here).
    'band-replay-narrow':
      surface === 'terminal'
        ? sized(at(3, band, bandDiffLines(12), 'truncate-end'), band, bandColumns)
        : text(band, lang === 'pt' ? 'Só num terminal estreito demais para o painel.' : 'Only in a terminal too narrow for the pane.', 'muted'),
  }

  return Object.keys(CATALOG_TEXT).map(id => {
    const [name, help] = CATALOG_TEXT[id]![lang]
    return { id, name, help, tree: staticTree(trees[id], pane.t) }
  })
}

// The hub's /mods panel. `lang` is the hub's; anything but 'pt' is English.
const TEXT = {
  en: {
    title: 'Replay',
    section: 'Last turn',
    edits: (n: number) => (n ? `${plural(n, 'edit', 'edits')} in the last turn` : 'no edits yet'),
    editsLabel: 'Edits recorded',
    editsValue: (n: number) => (n ? plural(n, 'edit', 'edits') : 'none yet'),
    open: 'Replay',
    openTitle: 'Replay the last turn',
    openHelp: 'Step through the last turn’s edits, one diff at a time',
    keys: 'In the pane: n next, p previous, c or Esc close.',
    nothing: 'Replay Theater: no edits in the last turn to replay.',
  },
  pt: {
    title: 'Replay',
    section: 'Último turno',
    edits: (n: number) => (n ? `${n} ${n === 1 ? 'edição' : 'edições'} no último turno` : 'nenhuma edição ainda'),
    editsLabel: 'Edições registradas',
    editsValue: (n: number) => (n ? `${n} ${n === 1 ? 'edição' : 'edições'}` : 'nenhuma ainda'),
    open: 'Rever',
    openTitle: 'Rever o último turno',
    openHelp: 'Percorre as edições do último turno, um diff por vez',
    keys: 'No painel: n próximo, p anterior, c ou Esc fecha.',
    nothing: 'Replay Theater: nenhuma edição no último turno para rever.',
  },
}

// The act carries no `lang`, so it answers in the one the last panel asked for.
let lastLang: 'en' | 'pt' = 'en'

const textOf = (lang: string) => (lang === 'pt' ? TEXT.pt : TEXT.en)

function panelOf(args: Partial<ReplayPanelArgs> | undefined): ReplayPanel {
  lastLang = args?.lang === 'pt' ? 'pt' : 'en'
  const t = textOf(lastLang)
  const n = state.replay.length
  return {
    title: t.title,
    summary: t.edits(n),
    tone: n ? 'accent' : 'muted',
    sections: [
      {
        id: 'last-turn',
        title: t.section,
        items: [
          { kind: 'info', label: t.editsLabel, value: t.editsValue(n), ...(n ? {} : { tone: 'muted' as const }) },
          { kind: 'text', text: t.keys, tone: 'muted' },
          // The group's main action, last.
          { kind: 'action', id: 'open', label: t.open, title: t.openTitle, help: t.openHelp, primary: n > 0 },
        ],
      },
    ],
  }
}

async function actOn($: EngineInterface, args: ReplayActArgs | undefined): Promise<ReplayActResult> {
  if (args?.id !== 'open') return {}
  if (!state.replay.length) return { message: textOf(lastLang).nothing }
  await openReplay($)
  return {}
}

export const register: Register = on => {
  // Adds `$.replay` for the hub's /mods panel. A call is the `replay.panel`,
  // `replay.act` or `replay.catalog` event, which the hooks below answer; the
  // stub is the floor.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      replay: { panel: async () => ({ title: '', sections: [] }), act: async () => ({}), catalog: async () => [] },
    }
  })

  on('replay.panel', async ($, e) => ({ value: panelOf(e) }))
  on('replay.act', async ($, e) => ({ value: await actOn($, e) }))
  on('replay.catalog', async ($, e) => ({ value: await catalogOf($, e) }))

  // Record each edit, then let it run. Never blocks the call.
  on('tool.call', async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      try {
        const steps = await stepsFor($, e as never)
        state.pending.push(...steps)
      } catch {
        // recording must never stop the edit
      }
    }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    // A subagent's turn carries its agentId; only the main loop's resets.
    if (!(e as { agentId?: string }).agentId) state.pending = []
    return next(e)
  })

  // At the end of a main-loop turn, the pending edits become the replay.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || !state.pending.length) return r
    state.replay = state.pending
    state.pending = []
    state.index = 0
    state.turns++
    $.ui.invalidate('ui.render')
    return r
  })

  // The band above the prompt: the hint and a button that opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (state.isOpen && state.inBand) return replayView($, e, true)
    if (!state.replay.length || state.isOpen) return next(e)
    const k = kitOf($.ui.resolve(e) as unknown as KitUi, toneOf(await skinOf($)), e.surface, e.props.bodyColumns || 80)
    return hintTree(k, state.replay.length, () => void openReplay($))
  })

  // The pane.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    return replayView($, e, false)
  })

  // The person closed the pane (Escape): keep our flag in step.
  on('ui.close', ($, e, next) => {
    if (e.id === PANE_ID) state.isOpen = false
    $.ui.invalidate('ui.render')
    return next(e)
  })
}
