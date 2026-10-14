import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The kit's drawing acts wait for every hook in flight to settle, and a held
// call is one, so these tests drive the hold to its end by the clock; the
// dialog itself is drawn by the catalog tests, from the same builders.

// The test environment's timer; the lib types here are ES only.
declare function setTimeout(fn: (value?: unknown) => void, ms: number): unknown

const tick = () => new Promise(resolve => setTimeout(resolve, 2))

// The engine around the mod: a folder, a shell whose rm dry run finds three
// files, a pane that places (or not), and the Bash tool itself.
function stub(on: On, { placed = true } = {}) {
  // The clock is moved by hand: the kit's own mock clock settles what is in flight first.
  const seen = { opens: [] as { id: string; title?: string }[], closes: 0, toasts: [] as string[], ran: [] as string[], now: 1_000 }
  on('clock.now', () => ({ value: seen.now }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', async ($, e) => {
    await tick()
    const stdout = e.argv[0] === 'bash' ? '3 6144 1\n./dist/a.js\n./dist/b.js\n./dist/c.js\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false } as never }
  })
  on('ui.open', ($, e) => {
    seen.opens.push({ id: e.id, title: e.title })
    return { value: { isPlaced: placed } as never }
  })
  on('ui.close', () => {
    seen.closes++
    return { value: undefined as never }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', ($, e) => {
    seen.ran.push(String((e as { command?: string }).command))
    return { result: { stdout: 'ok' } as never }
  })
  return seen
}

async function holdToTimeout($: Engine, command: string, seen: ReturnType<typeof stub>) {
  const call = $.tool.call({ tool: 'Bash', command } as never)
  for (let k = 0; k < 500 && seen.opens.length === 0; k++) await tick()
  expect(seen.opens).toEqual([{ id: 'blast-radius', title: 'Blast Radius' }])
  expect(seen.ran).toEqual([])
  seen.now += 10 * 60 * 1000 + 1
  return (await call) as { deny?: string }
}

test('a safe command runs without a hold', async ($, on) => {
  const seen = stub(on)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' } as never)
  expect(seen.ran).toEqual(['ls -la'])
  expect(seen.opens).toEqual([])
})

test('rm -rf is held in a pane, and refused with what it would do when nobody answers', async ($, on) => {
  const seen = stub(on)
  const result = await holdToTimeout($, 'rm -rf dist', seen)
  expect(result.deny).toBe(
    'Blast Radius held this command and did not run it: no answer within 10 minutes. It would have: delete 3 files (about 6.0 KB). Do not retry it unless the user asks you to.',
  )
  expect(seen.ran).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.closes).toBe(1)
})

test('with no room for a pane, the hold still waits, and closes no pane', async ($, on) => {
  const seen = stub(on, { placed: false })
  const result = await holdToTimeout($, 'git reset --hard', seen)
  expect(result.deny).toContain('no answer within 10 minutes')
  expect(seen.ran).toEqual([])
  expect(seen.closes).toBe(0)
})
