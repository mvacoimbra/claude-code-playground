import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import type { ReplayActResult, ReplayItem, ReplayPanel, ReplayPanelArgs } from '../types'

// The host lets only a module call another plugin's noun, so a stand-in for the
// /mods hub calls `$.replay` from two commands of its own and hands back JSON.
const HUB: Plugin = {
  name: 'hub',
  register(on) {
    on('command.run', { command: 'hub-panel' }, async ($, e) => ({ text: JSON.stringify(await $.replay.panel(JSON.parse(e.args))) }))
    on('command.run', { command: 'hub-act' }, async ($, e) => ({ text: JSON.stringify(await $.replay.act(JSON.parse(e.args))) }))
  },
}

const ARGS: ReplayPanelArgs = { lang: 'en', surface: 'terminal', columns: 80 }

// The person typing `/<command> <json>`; the engine stamps origin and presentation.
async function run($: Engine, command: string, args: unknown) {
  return JSON.parse((await $.command.run({ command, args: JSON.stringify(args) } as never)).text ?? '')
}

const panel = ($: Engine, args: ReplayPanelArgs = ARGS): Promise<ReplayPanel> => run($, 'hub-panel', args)

const act = ($: Engine, id: string): Promise<ReplayActResult> => run($, 'hub-act', { id })

const itemsOf = (p: ReplayPanel): ReplayItem[] => p.sections.flatMap(s => s.items)

const actionOf = (p: ReplayPanel, id: string) =>
  itemsOf(p).find((i): i is Extract<ReplayItem, { kind: 'action' }> => i.kind === 'action' && i.id === id)

test('the panel is a Replay tab with the open action', { plugins: [HUB] }, async $ => {
  const p = await panel($)
  expect(p.title).toBe('Replay')
  expect(p.summary).toBe('no edits yet')
  expect(p.sections).toHaveLength(1)
  expect(actionOf(p, 'open')?.label).toBe('Replay')
  expect(actionOf(p, 'open')?.help).toBe('Step through the last turn’s edits, one diff at a time')
  // With nothing to replay yet, the action is not the accent; the count says why.
  expect(actionOf(p, 'open')?.primary).toBe(false)
  expect(itemsOf(p).find(i => i.kind === 'info')).toEqual({ kind: 'info', label: 'Edits recorded', value: 'none yet', tone: 'muted' })
  expect(itemsOf(p).some(i => i.kind === 'text')).toBe(true)
})

test('the panel speaks Portuguese when the hub does', { plugins: [HUB] }, async $ => {
  const p = await panel($, { ...ARGS, lang: 'pt' })
  expect(p.title).toBe('Replay')
  expect(p.summary).toBe('nenhuma edição ainda')
  expect(p.sections[0]?.title).toBe('Último turno')
  expect(actionOf(p, 'open')?.label).toBe('Rever')
  expect(JSON.stringify(p)).not.toContain('last turn')
})

test('open reports nothing to replay before any edit', { plugins: [HUB] }, async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })

  expect((await act($, 'open')).message).toContain('no edits')
  expect(opened).toBe(0)

  await panel($, { ...ARGS, lang: 'pt' })
  expect((await act($, 'open')).message).toContain('nenhuma edição')
})

test('open opens the replay pane after a turn with edits', { plugins: [HUB] }, async ($, on) => {
  const clock = mock.clock(on)
  const opens: { id: string; title?: string }[] = []
  on('session.cwd', () => ({ value: '/repo' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} as never }))
  on('ui.open', ($, e) => {
    opens.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })

  await $.turn.start({ text: 'rename greet', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'greet()', new_string: 'welcome()' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  expect((await panel($)).summary).toBe('1 edit in the last turn')
  expect(actionOf(await panel($), 'open')?.primary).toBe(true)
  expect(itemsOf(await panel($)).find(i => i.kind === 'info')).toEqual({ kind: 'info', label: 'Edits recorded', value: '1 edit' })
  expect((await panel($, { ...ARGS, lang: 'pt' })).summary).toBe('1 edição no último turno')

  // Opening waits 200ms for the band to let go of the keys, as /replay did.
  const acting = act($, 'open')
  await clock.advance(200)
  expect((await acting).message).toBeUndefined()
  expect(opens).toEqual([{ id: 'replay-theater', title: 'Replay Theater' }])
})

test('no replay slash command is registered', async ($, on) => {
  const names: string[] = []
  on('command.register', ($, e) => {
    names.push(e.name)
    return { value: undefined as never }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(names).not.toContain('replay')
})

test('an edit is numbered where it lands in the file', async ($, on) => {
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'one\ntwo\ngreet()\nfour\n' as never }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} as never }))

  await $.turn.start({ text: 'rename', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'greet()', new_string: 'welcome()' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const pane = await $.ui.mount({
    plugin: 'replay-theater', surface: 'desktop', viewport: { columns: 100, rows: 30 }, component: 'Pane', requestId: 'replay-theater',
    props: { title: 'Replay Theater', isFocused: true, bodyColumns: 58, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(JSON.stringify(await pane.drawn())).toContain('@@ -3,1 +3,1 @@\\n-greet()\\n+welcome()')
  await pane.unmount()
})
