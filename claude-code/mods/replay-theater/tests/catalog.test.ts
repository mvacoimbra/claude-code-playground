import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import type { ReplayCatalogEntry, ReplayPanelArgs } from '../types'

// The host lets only a module call another plugin's noun, so a stand-in for the
// /mods hub calls `$.replay.catalog` from a command of its own and hands back JSON.
// Like the hub's Components tab, it also draws the last catalog it fetched in a
// pane of its own, which proves each tree is one another plugin can draw.
const HUB: Plugin = {
  name: 'hub',
  register(on) {
    let shown: { id: string; tree: unknown }[] = []
    on('command.run', { command: 'hub-catalog' }, async ($, e) => {
      shown = await $.replay.catalog(JSON.parse(e.args))
      return { text: JSON.stringify(shown) }
    })
    on('command.run', { command: 'hub-act' }, async ($, e) => ({ text: JSON.stringify(await $.replay.act(JSON.parse(e.args))) }))
    on('ui.render', { component: 'Pane' }, ($, e, next) => {
      if (e.requestId !== 'hub-components') return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return Box({
        flexDirection: 'column',
        children: shown.map(entry => Box({ key: `entry-${entry.id}`, flexDirection: 'column', children: [Text({ bold: true, children: entry.id }), entry.tree as never] })),
      })
    })
  },
}

const SURFACES = ['terminal', 'desktop'] as const
const ARGS: ReplayPanelArgs = { lang: 'en', surface: 'terminal', columns: 100 }

const PANE = {
  plugin: 'replay-theater',
  viewport: { columns: 100, rows: 30 },
  component: 'Pane',
  requestId: 'replay-theater',
  props: { title: 'Replay Theater', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const IDS = [
  'band-hint',
  'pane-first-step',
  'pane-multiedit-step',
  'pane-write-new-file',
  'pane-write-rewrite',
  'pane-no-line-changes',
  'pane-last-step',
  'pane-no-edits',
  'pane-header',
  'step-strip',
  'step-file-and-counts',
  'diff-lines',
  'diff-skipped-run',
  'diff-more-lines',
  'diff-no-line-changes',
  'nav-buttons',
  'band-replay-narrow',
]

async function catalog($: Engine, args: Partial<ReplayPanelArgs> = {}): Promise<ReplayCatalogEntry[]> {
  const out = await $.command.run({ command: 'hub-catalog', args: JSON.stringify({ ...ARGS, ...args }) } as never)
  return JSON.parse(out.text ?? '')
}

type Node = { type?: string; props?: { label?: string; width?: number; source?: string; format?: string }; children?: unknown }

// Every string a tree shows, and every element type in it, depth first.
// A Code element (the path, the diff) shows its source.
function texts(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (Array.isArray(tree)) return tree.flatMap(texts)
  if (tree && typeof tree === 'object') {
    const node = tree as Node
    return node.type === 'Code' ? [String(node.props?.source ?? '')] : texts(node.children)
  }
  return []
}

// The text of each element on its own line: a Text's runs joined, a Box's children split.
function lines(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (Array.isArray(tree)) return tree.flatMap(lines)
  if (tree && typeof tree === 'object') {
    const node = tree as Node
    return node.type === 'Text' || node.type === 'Code' ? [texts(node).join('')] : lines(node.children)
  }
  return []
}

function types(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(types)
  if (tree && typeof tree === 'object') {
    const node = tree as Node
    return [...(node.type ? [node.type] : []), ...types(node.children)]
  }
  return []
}

const shown = (entry: ReplayCatalogEntry | undefined) => lines(entry?.tree).join('\n')
const byId = (entries: ReplayCatalogEntry[], id: string) => entries.find(e => e.id === id)

test('the catalog lists every component, named, with a tree each, on both surfaces', { plugins: [HUB] }, async $ => {
  for (const surface of SURFACES) {
    const entries = await catalog($, { surface })
    expect(entries.map(e => e.id), surface).toEqual(IDS)
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.id, surface).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(entry.name.length, `${surface} ${entry.id}`).toBeGreaterThan(3)
      expect(entry.help?.length ?? 0, `${surface} ${entry.id}`).toBeGreaterThan(10)
      expect((entry.tree as { type?: string }).type, `${surface} ${entry.id}`).toMatch(/^(Box|Text)$/)
    }
  }
})

test('the samples are drawn with the pane’s own builders', { plugins: [HUB] }, async $ => {
  const entries = await catalog($)

  const first = shown(byId(entries, 'pane-first-step'))
  expect(first).toContain('1 of 7')
  expect(first).toContain('src/greet.ts')
  // The diff is unified hunks for the engine's Code element, numbered where the edit landed.
  expect(first).toContain('@@ -3,3 +3,3 @@')
  expect(first).toContain('-export function greet(name: string) {')
  expect(first).toContain('+export function welcome(name: string) {')
  expect(first).toContain('Previous')

  expect(shown(byId(entries, 'pane-multiedit-step'))).toContain('MultiEdit · edit 2 of 2')
  expect(shown(byId(entries, 'pane-write-new-file'))).toContain('Write · new file')
  expect(shown(byId(entries, 'pane-write-new-file'))).toContain('@@ -0,0 +1,12 @@')
  expect(shown(byId(entries, 'pane-write-new-file'))).toContain('… 4 more lines')
  expect(shown(byId(entries, 'pane-write-rewrite'))).toContain('Write · rewrite')
  expect(shown(byId(entries, 'pane-write-rewrite'))).toContain('@@ -7,3 +7,3 @@')
  expect(shown(byId(entries, 'pane-no-line-changes'))).toContain('No line changes')
  expect(shown(byId(entries, 'pane-last-step'))).toContain('7 of 7')
  expect(shown(byId(entries, 'pane-last-step'))).toContain('Edit · replace all')
  expect(shown(byId(entries, 'pane-no-edits'))).toContain('No edits to replay.')
  expect(shown(byId(entries, 'band-hint'))).toContain('7 edits in the last turn')
  expect(shown(byId(entries, 'band-hint'))).toContain('press r')
  // A skipped run splits the diff into two hunks, each with its own numbers.
  expect(shown(byId(entries, 'diff-skipped-run')).match(/@@ -\d+,\d+ \+\d+,\d+ @@/g)).toHaveLength(2)
  expect(shown(byId(entries, 'diff-more-lines'))).toContain('… 3 more lines')
  expect(shown(byId(entries, 'step-file-and-counts'))).toBe('src/greet.ts\nEdit\n+2\n-2')
  // Static: each Button is drawn as its shape, a round hairline box, the main action filled.
  expect(shown(byId(entries, 'nav-buttons'))).toBe('Previous\nNext\nClose')
  const boxes = (tree: unknown): Node[] => {
    if (Array.isArray(tree)) return tree.flatMap(boxes)
    if (tree && typeof tree === 'object') {
      const node = tree as Node & { props?: { borderStyle?: string; backgroundColor?: string } }
      return [...(node.type === 'Box' && node.props?.borderStyle === 'round' ? [node] : []), ...boxes(node.children)]
    }
    return []
  }
  const buttons = boxes(byId(entries, 'nav-buttons')?.tree) as (Node & { props?: { backgroundColor?: string } })[]
  expect(buttons.map(b => texts(b).join(''))).toEqual(['Previous', 'Next', 'Close'])
  expect(buttons.map(b => b.props?.backgroundColor)).toEqual([undefined, '#d97757', undefined])
  expect(shown(byId(entries, 'band-hint'))).toContain('Replay')
  for (const entry of entries) expect(types(entry.tree), entry.id).not.toContain('Button')
})

test('the diff is the engine’s Code element, in the file’s language', { plugins: [HUB] }, async $ => {
  const codes = (tree: unknown): Node[] => {
    if (Array.isArray(tree)) return tree.flatMap(codes)
    if (tree && typeof tree === 'object') {
      const node = tree as Node
      return node.type === 'Code' ? [node] : codes(node.children)
    }
    return []
  }
  for (const surface of SURFACES) {
    const diff = codes(byId(await catalog($, { surface }), 'diff-lines')?.tree)
    expect(diff, surface).toHaveLength(1)
    expect(diff[0]?.props, surface).toMatchObject({ format: 'diff', path: 'src/greet.ts', language: 'typescript' })
  }
})

test('the catalog is drawn at the hub’s width', { plugins: [HUB] }, async $ => {
  for (const columns of [100, 60]) {
    const entries = await catalog($, { columns })
    expect((byId(entries, 'pane-first-step')?.tree as { props: { width: number } }).props.width).toBe(columns)
    expect((byId(entries, 'band-hint')?.tree as { props: { width: number } }).props.width).toBe(columns)
  }
})

test('the narrow band replay is a terminal piece', { plugins: [HUB] }, async $ => {
  const terminal = byId(await catalog($, { surface: 'terminal' }), 'band-replay-narrow')
  expect(shown(terminal)).toContain('Next')
  expect(shown(terminal)).toContain('4 of 7')
  // The band's shorter diff: five of the sixteen lines, then the rest counted.
  expect(shown(terminal)).toContain('… 11 more lines')

  const desktop = byId(await catalog($, { surface: 'desktop' }), 'band-replay-narrow')
  expect((desktop?.tree as { type: string }).type).toBe('Text')
  expect(shown(desktop)).toContain('terminal')
})

test('the catalog speaks Portuguese when the hub does, with the same ids', { plugins: [HUB] }, async $ => {
  const en = await catalog($)
  const pt = await catalog($, { lang: 'pt' })
  expect(pt.map(e => e.id)).toEqual(en.map(e => e.id))
  expect(byId(pt, 'pane-first-step')?.name).toBe('Painel do replay, primeiro passo (um Edit)')
  expect(byId(pt, 'nav-buttons')?.name).toBe('Botões de navegação')
  for (const [k, entry] of pt.entries()) {
    expect(entry.name, entry.id).not.toBe(en[k]?.name)
    expect(entry.help, entry.id).not.toBe(en[k]?.help)
  }
  expect(shown(byId(await catalog($, { lang: 'pt', surface: 'desktop' }), 'band-replay-narrow'))).toContain('terminal estreito')
})

test('another plugin can draw every catalog tree, on both surfaces', { plugins: [HUB] }, async $ => {
  for (const surface of SURFACES) {
    for (const lang of ['en', 'pt'] as const) {
      await catalog($, { surface, lang, columns: 80 })
      const pane = await $.ui.mount({ ...PANE, plugin: 'hub', requestId: 'hub-components', surface })
      for (const id of IDS) expect(await pane.find({ key: `entry-${id}` }), `${surface} ${lang} ${id}`).toBeDefined()
      expect(await pane.find({ type: 'Text', text: '1 of 7' }), surface).toBeDefined()
      await pane.unmount()
    }
  }
})


const BAND = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 95, scroll: { offset: 0, bodyRows: 20 }, view: {} } as never

test('the live band and pane still draw and steps through a turn’s edits', { plugins: [HUB] }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.cwd', () => ({ value: '/repo' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined as never }))

  await $.turn.start({ text: 'rename', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'greet()', new_string: 'welcome()' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/b.ts', old_string: 'greet', new_string: 'welcome', replace_all: true } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'replay-theater', surface, viewport: { columns: 100, rows: 30 }, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: '2 edits in the last turn' }), surface).toBeDefined()
    expect(await band.find({ key: 'open-replay' }), surface).toBeDefined()
    await band.unmount()
  }

  const opening = $.command.run({ command: 'hub-act', args: JSON.stringify({ id: 'open' }) } as never)
  await clock.advance(200)
  await opening

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: '1 of 2' }), surface).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'a.ts' }), surface).toBeDefined()
    await pane.press({ key: 'next' })
    expect(await pane.find({ type: 'Text', text: '2 of 2' }), surface).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Edit · replace all' }), surface).toBeDefined()
    await pane.press({ key: 'prev' })
    expect(await pane.find({ type: 'Text', text: '1 of 2' }), surface).toBeDefined()
    await pane.unmount()
  }
})
