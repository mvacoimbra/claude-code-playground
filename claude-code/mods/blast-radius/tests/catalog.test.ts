import { expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import type { BlastCatalogEntry, BlastPanelArgs } from '../types'

// The host lets only a module call another plugin's noun, so a stand-in for the
// /mods hub calls `$.blast.catalog` from a command of its own and hands back JSON.
// Like the hub's Components tab, it also draws the last catalog it fetched in a
// pane of its own, which proves each tree is one another plugin can draw.
const HUB: Plugin = {
  name: 'hub',
  register(on) {
    let shown: { id: string; tree: unknown }[] = []
    on('command.run', { command: 'hub-catalog' }, async ($, e) => {
      shown = await $.blast.catalog(JSON.parse(e.args))
      return { text: JSON.stringify(shown) }
    })
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
const ARGS: BlastPanelArgs = { lang: 'en', surface: 'terminal', columns: 100 }

const PANE = {
  plugin: 'hub',
  viewport: { columns: 100, rows: 40 },
  component: 'Pane',
  requestId: 'hub-components',
  props: { title: 'Mods', isFocused: true, bodyColumns: 90, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const IDS = [
  'hold-rm-rf',
  'hold-git-reset-hard',
  'hold-git-checkout',
  'hold-git-clean',
  'hold-force-push',
  'hold-migration',
  'hold-migration-unknown-tool',
  'hold-migration-nothing-pending',
  'hold-migration-list-failed',
  'hold-nothing-to-delete',
  'hold-empty-folders',
  'hold-rm-no-paths',
  'hold-nothing-to-discard',
  'hold-nothing-to-clean',
  'hold-force-push-drops-nothing',
  'hold-force-push-unknown',
  'hold-not-a-repo',
  'hold-missing-folder',
  'hold-measure-failed',
  'hold-in-band',
  'dialog-title',
  'command-row',
  'would-row',
  'preview-list',
  'note-line',
  'decision-buttons',
  'decided-proceed',
  'decided-cancel',
  'toast-proceed',
  'denied-cancel',
  'denied-timeout',
  'denied-interrupted',
  'denied-while-queued',
  'denied-error',
]

async function catalog($: Engine, args: Partial<BlastPanelArgs> = {}): Promise<BlastCatalogEntry[]> {
  const out = await $.command.run({ command: 'hub-catalog', args: JSON.stringify({ ...ARGS, ...args }) } as never)
  return JSON.parse(out.text ?? '')
}

type Node = { type?: string; props?: { width?: number; source?: string; alt?: string; color?: string; language?: string }; children?: unknown }

// A Code element (the command, the list) shows its source.
function texts(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (Array.isArray(tree)) return tree.flatMap(texts)
  if (tree && typeof tree === 'object') {
    const node = tree as Node
    return node.type === 'Code' ? [String(node.props?.source ?? '')] : texts(node.children)
  }
  return []
}

// Every element of a type, depth first.
function all(tree: unknown, type: string): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(t => all(t, type))
  if (tree && typeof tree === 'object') {
    const node = tree as Node
    return [...(node.type === type ? [node] : []), ...all(node.children, type)]
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

const shown = (entry: BlastCatalogEntry | undefined) => lines(entry?.tree).join('\n')
const byId = (entries: BlastCatalogEntry[], id: string) => entries.find(e => e.id === id)

test('the catalog lists every component, named, with a tree each, on both surfaces', { plugins: [HUB] }, async $ => {
  for (const surface of SURFACES) {
    const entries = await catalog($, { surface })
    expect(entries.map(e => e.id), surface).toEqual(IDS)
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length)
    for (const entry of entries) {
      expect(entry.id, surface).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(entry.name.length, `${surface} ${entry.id}`).toBeGreaterThan(3)
      expect(entry.help?.length ?? 0, `${surface} ${entry.id}`).toBeGreaterThan(10)
      expect((entry.tree as Node).type, `${surface} ${entry.id}`).toBe('Box')
      expect(types(entry.tree), `${surface} ${entry.id}`).not.toContain('Button')
    }
  }
})

test('each risky kind has its own hold dialog, drawn from the real reports', { plugins: [HUB] }, async $ => {
  const entries = await catalog($)

  const rm = shown(byId(entries, 'hold-rm-rf'))
  expect(rm).toContain('⚠\nBlast Radius · rm -rf')
  expect(rm).toContain('Command\nrm -rf dist .cache')
  expect(rm).toContain('Would\ndelete 214 files (about 3.4 MB)')
  expect(rm).toContain('dist/index.js\ndist/index.js.map')
  expect(rm).toContain('+ 204 more')
  expect(rm).toContain('1: Proceed')
  expect(rm).toContain('2: Cancel')
  expect(rm).toContain('Claude is waiting on your answer')

  expect(shown(byId(entries, 'hold-git-reset-hard'))).toContain('discard uncommitted changes in 5 files')
  expect(shown(byId(entries, 'hold-git-checkout'))).toContain('Blast Radius · git checkout -- .')
  expect(shown(byId(entries, 'hold-git-checkout'))).toContain('discard uncommitted changes in 3 files')
  expect(shown(byId(entries, 'hold-git-clean'))).toContain('remove 6 untracked paths')
  expect(shown(byId(entries, 'hold-force-push'))).toContain('force-push to origin/main: drops 3 commits')
  expect(shown(byId(entries, 'hold-migration'))).toContain('apply 3 pending migrations')
  expect(shown(byId(entries, 'hold-migration-unknown-tool'))).toContain("I can't list the pending migrations")
  expect(shown(byId(entries, 'hold-migration-nothing-pending'))).toContain('nothing pending')
  expect(shown(byId(entries, 'hold-migration-list-failed'))).toContain("Couldn't list pending migrations")
  expect(shown(byId(entries, 'hold-nothing-to-delete'))).toContain('delete nothing: no file matches tmp/*.log')
  expect(shown(byId(entries, 'hold-empty-folders'))).toContain('delete 2 paths with no files in them')
  expect(shown(byId(entries, 'hold-rm-no-paths'))).toContain('rm with no paths')
  expect(shown(byId(entries, 'hold-nothing-to-discard'))).toContain('discard nothing: no uncommitted changes')
  expect(shown(byId(entries, 'hold-nothing-to-clean'))).toContain('remove nothing: no untracked files match')
  expect(shown(byId(entries, 'hold-force-push-drops-nothing'))).toContain('drops no commits')
  expect(shown(byId(entries, 'hold-force-push-unknown'))).toContain('Run git fetch first.')
  expect(shown(byId(entries, 'hold-not-a-repo'))).toContain('(not a git repo here?)')
  expect(shown(byId(entries, 'hold-missing-folder'))).toContain("Couldn't find the folder packages/old-api")
  expect(shown(byId(entries, 'hold-measure-failed'))).toContain('(could not measure it)')

  expect(shown(byId(entries, 'dialog-title'))).toBe('⚠\nBlast Radius · rm -rf')
  expect(shown(byId(entries, 'command-row'))).toBe('Command\nrm -rf dist .cache')
  expect(shown(byId(entries, 'would-row'))).toBe('Would\ndelete 214 files (about 3.4 MB)')
  expect(shown(byId(entries, 'preview-list')).split('\n')).toHaveLength(11)
  expect(shown(byId(entries, 'note-line'))).toBe('Paths: dist .cache')
  expect(shown(byId(entries, 'decision-buttons'))).toBe('●\nClaude is waiting on your answer\n1: Proceed\n2: Cancel')
  expect(shown(byId(entries, 'decided-proceed'))).toBe('●\nProceeding · running it')
  expect(shown(byId(entries, 'decided-cancel'))).toBe('●\nCancelled · not run')
  expect(shown(byId(entries, 'toast-proceed'))).toBe('●\nBlast Radius: running it')
  expect(shown(byId(entries, 'denied-cancel'))).toContain('Cancelled · not run')
  expect(shown(byId(entries, 'denied-cancel'))).toContain('the user pressed Cancel. It would have: delete 214 files')
  expect(shown(byId(entries, 'denied-timeout'))).toContain('no answer within 10 minutes')
  expect(shown(byId(entries, 'denied-interrupted'))).toContain('the turn was interrupted. It would have')
  expect(shown(byId(entries, 'denied-while-queued'))).toContain('the turn was interrupted. Do not retry')
  expect(shown(byId(entries, 'denied-error'))).toContain('hit an error while holding it')
})

test('on the desktop, the icon and colour follow severity, and Cancel is the accented choice', { plugins: [HUB] }, async $ => {
  const entries = await catalog($, { surface: 'desktop' })
  const iconOf = (id: string) => all(byId(entries, id)?.tree, 'Svg')[0]?.props?.alt
  // Work that can't be got back: the alert, in the error colour.
  for (const id of ['hold-rm-rf', 'hold-git-reset-hard', 'hold-git-clean', 'hold-force-push']) expect(iconOf(id), id).toBe('alert')
  expect(all(byId(entries, 'would-row')?.tree, 'Text').find(t => texts(t).join('') === 'delete 214 files (about 3.4 MB)')?.props?.color).toBe('error')
  // A migration, or a command that would change nothing: the shield, in the warning colour.
  for (const id of ['hold-migration', 'hold-nothing-to-delete', 'hold-nothing-to-discard', 'hold-force-push-drops-nothing']) expect(iconOf(id), id).toBe('shield')
  // The command is mono, with the shell's colours.
  expect(all(byId(entries, 'command-row')?.tree, 'Code')[0]?.props).toMatchObject({ source: 'rm -rf dist .cache', language: 'bash' })
  // Cancel, the safe default, has the accent; Proceed stays plain.
  const buttons = all(byId(entries, 'decision-buttons')?.tree, 'Text')
  expect(buttons.find(t => texts(t).join('') === '[ Cancel ]')?.props?.color).toBe('claude')
  expect(buttons.find(t => texts(t).join('') === '[ Proceed ]')?.props?.color).toBeUndefined()
})

test('the catalog is drawn at the hub’s width', { plugins: [HUB] }, async $ => {
  for (const columns of [100, 60]) {
    const entries = await catalog($, { columns })
    for (const entry of entries) expect((entry.tree as Node).props?.width, `${columns} ${entry.id}`).toBe(entry.id === 'hold-in-band' ? Math.min(columns, 80) : columns)
  }
})

test('the dialog in the band is a terminal piece', { plugins: [HUB] }, async $ => {
  const terminal = byId(await catalog($, { surface: 'terminal' }), 'hold-in-band')
  expect(shown(terminal)).toContain('Blast Radius · rm -rf')
  expect(shown(terminal)).toContain('2: Cancel')

  const desktop = byId(await catalog($, { surface: 'desktop' }), 'hold-in-band')
  expect(shown(desktop)).toBe('Only in a terminal too narrow for the pane.')
  expect(shown(byId(await catalog($, { surface: 'desktop', lang: 'pt' }), 'hold-in-band'))).toContain('terminal estreito')
})

test('the catalog speaks Portuguese when the hub does, with the same ids', { plugins: [HUB] }, async $ => {
  const en = await catalog($)
  const pt = await catalog($, { lang: 'pt' })
  expect(pt.map(e => e.id)).toEqual(en.map(e => e.id))
  expect(byId(pt, 'hold-rm-rf')?.name).toBe('Diálogo de espera, rm -rf')
  expect(byId(pt, 'decision-buttons')?.name).toBe('Botões Proceed e Cancel')
  for (const [k, entry] of pt.entries()) {
    expect(entry.name, entry.id).not.toBe(en[k]?.name)
    expect(entry.help, entry.id).not.toBe(en[k]?.help)
  }
})

test('another plugin can draw every catalog tree, on both surfaces', { plugins: [HUB] }, async $ => {
  for (const surface of SURFACES) {
    for (const lang of ['en', 'pt'] as const) {
      await catalog($, { surface, lang, columns: 80 })
      const pane = await $.ui.mount({ ...PANE, surface })
      for (const id of IDS) expect(await pane.find({ key: `entry-${id}` }), `${surface} ${lang} ${id}`).toBeDefined()
      expect(await pane.find({ type: 'Text', text: 'Blast Radius · rm -rf' }), surface).toBeDefined()
      await pane.unmount()
    }
  }
})
