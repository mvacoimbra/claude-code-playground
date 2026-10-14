// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Blast Radius: holds a risky Bash command and shows what it would change.
//
// tool.call (Bash): if the command is risky, work out its blast radius, open a
// pane with Proceed and Cancel, and hold the call until one is pressed.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run(["sleep", ...])` until
// a button's onPress sets the decision.
//
// $.blast.catalog: every component it draws, named, for the Components tab of
// the /mods hub (it has no tab of its own there).
//
// Drawn with the pack's shared kit (hooks/kit), in the colours of the skin
// chosen in skins, or Claude Code's own without it.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

import type { EngineInterface, Register, RenderElement, RenderSurface } from 'claude-code'

import { action, icon, kitOf, status, text } from './kit/kit'
import type { Kit, KitUi } from './kit/kit'
import { toneOf } from './kit/tone'
import type { KitSkin, KitTone } from './kit/tone'
import type { BlastCatalogEntry, BlastPanelArgs } from '../types'

const PANE_ID = 'blast-radius'
const POLL_SECONDS = '0.25'
const HOLD_LIMIT_MS = 10 * 60 * 1000
const LIST_MAX = 10

// What the person sees after a choice: the toast on Proceed, and the reason a
// held call was refused, which Claude Code shows on the call and Claude reads.
const PROCEED_TOAST = 'Blast Radius: running it'
const QUEUED_DENY = 'Blast Radius held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to.'
const DENY_REASONS: Record<string, string> = {
  cancel: 'the user pressed Cancel',
  timeout: 'no answer within 10 minutes',
  interrupted: 'the turn was interrupted',
  error: 'Blast Radius hit an error while holding it',
}

function denyMessage(decision: string | null, summary: string): string {
  const why = (decision !== null && DENY_REASONS[decision]) || 'no answer was recorded'
  return `Blast Radius held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`
}

// The words and colour of what happened to a held command, as a live state.
type Outcome = 'proceed' | 'cancel' | 'timeout' | 'interrupted' | 'queued' | 'error'
const OUTCOMES: Record<Outcome, { word: string; tone: KitTone }> = {
  proceed: { word: 'Proceeding · running it', tone: 'warn' },
  cancel: { word: 'Cancelled · not run', tone: 'ok' },
  timeout: { word: 'No answer · not run', tone: 'warn' },
  interrupted: { word: 'Interrupted · not run', tone: 'muted' },
  queued: { word: 'Interrupted while waiting · not run', tone: 'muted' },
  error: { word: 'Error · not run', tone: 'err' },
}

type Risk = { kind: string; label: string; dir: string | null; targets?: string[]; args?: string[]; tool?: string }
type Report = { summary: string; lines: string[]; more?: number; note: string; nothing?: boolean }
type Held = { command: string; risk: Risk; report: Report | null; decision: Outcome | null; where: 'pane' | 'band' }
type Run = { exitCode: number; stdout: string; stderr: string }

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held: Held | null = null

// The skin every mod wears, from skins; Claude Code's own colours without it.
async function skinOf($: EngineInterface): Promise<KitSkin | null> {
  try {
    return await $.skins.palette()
  } catch {
    return null // skins not installed: Claude Code's own colours
  }
}

// The hold dialog for the site being drawn, in the skin's colours.
async function drawHeld($: EngineInterface, e: { surface: RenderSurface; props: { bodyColumns: number } }, mine: Held): Promise<RenderElement> {
  const k = kitOf($.ui.resolve(e as never) as unknown as KitUi, toneOf(await skinOf($)), e.surface, e.props.bodyColumns || 80)
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice: Outcome) => () => {
    if (mine.decision === null) {
      mine.decision = choice
      $.ui.invalidate('ui.render')
    }
  }
  return dialog(k, { label: mine.risk.label, kind: mine.risk.kind, command: mine.command, report: mine.report!, decision: mine.decision, onProceed: decide('proceed'), onCancel: decide('cancel') })
}

export const register: Register = on => {
  // Adds `$.blast` for the /mods hub: no tab, only the catalog of what Blast
  // Radius draws, for the hub's Components tab. A call is the `blast.catalog`
  // event, which the hook below answers; the stub is the floor.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return { ...built, blast: { catalog: async () => [] } }
  })

  on('blast.catalog', async ($, e) => ({ value: await catalogOf($, e) }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String((e as { command?: string }).command ?? '')
    const risk = classify(command)
    if (risk === null) {
      return next(e)
    }
    // One hold at a time. If another risky call is already held (a subagent's,
    // say), wait until it is answered. `held` is claimed with no await between
    // the check and the claim, so two waiting calls can't both get through.
    while (held !== null) {
      if (next.signal.aborted) {
        return { deny: QUEUED_DENY }
      }
      await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
    }
    const mine: Held = { command, risk, report: null, decision: null, where: 'pane' }
    held = mine

    let opened: { isPlaced: boolean } = { isPlaced: false }
    let decision: Outcome | null
    let summary = risk.label
    try {
      // Measure where the command will run: the session folder, moved by any
      // `cd dir &&` or `git -C dir` earlier in the same command line.
      const sessionCwd = await $.session.cwd()
      const cwd = risk.dir ? await resolveDir($, sessionCwd, risk.dir) : sessionCwd
      mine.report = cwd === null ? missingDirReport(risk) : await measure($, risk, cwd)
      summary = mine.report.summary

      opened = (await $.ui.open({ id: PANE_ID, title: 'Blast Radius', focus: true, rows: paneRows(mine.report) })) ?? { isPlaced: false }
      if (!opened.isPlaced) {
        mine.where = 'band'
      }
      $.ui.invalidate('ui.render')

      const startedAt = await $.clock.now()
      while (mine.decision === null) {
        if (next.signal.aborted) {
          mine.decision = 'interrupted'
          break
        }
        if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
          mine.decision = 'timeout'
          break
        }
        await $.process.run(['sleep', POLL_SECONDS], { timeoutMs: 5000 })
      }
    } catch {
      mine.decision = 'error' // anything unexpected refuses the command
    } finally {
      decision = mine.decision
      // Close this call's pane before releasing the hold, so the next call's
      // pane can't be the one that gets closed.
      try {
        if (opened.isPlaced) {
          await $.ui.close({ id: PANE_ID })
        }
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null
      }
      $.ui.invalidate('ui.render')
    }

    if (decision === 'proceed') {
      $.ui.toast(PROCEED_TOAST)
      return next(e)
    }
    return { deny: denyMessage(decision, summary) }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const mine = held
    if (e.requestId !== PANE_ID || mine === null || mine.report === null) {
      return next(e)
    }
    return drawHeld($, e, mine)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mine = held
    if (mine === null || mine.report === null || mine.where !== 'band') {
      return next(e)
    }
    return drawHeld($, e, mine)
  })
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'])
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(['ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'find', 'less', 'head', 'tail', 'cd', 'git'])

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir: string | null, arg: string | undefined): string {
  if (arg === undefined || arg === '~' || arg.startsWith('/') || arg.startsWith('~/')) {
    return arg ?? '~'
  }
  return dir ? `${dir}/${arg}` : arg
}

/** The first risky segment of a shell command, or null. */
function classify(command: string): Risk | null {
  let dir: string | null = null // where a `cd` earlier on the line moved to; null means the session folder
  const scopes: (string | null)[] = [] // dir to restore when a ( subshell ) closes
  const pushed: (string | null)[] = [] // pushd stack, for popd
  for (const raw of command.split(/&&|\|\||;|\||\n/)) {
    const opens = raw.match(/^\s*\(+/)?.[0].trim().length ?? 0
    // Trailing redirects and & don't hide a closing ) : `(cd sub && make) > log`.
    const tail = raw.replace(/(?:\s*(?:\d*>>?|&>>?|<)\s*\S+|\s*&)+\s*$/, '')
    const closes = tail.match(/\)+\s*$/)?.[0].trim().length ?? 0
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir)
    }
    const risk = classifySegment(raw, dir, pushed)
    if (risk !== null && !('cd' in risk)) {
      return risk
    }
    if (risk !== null) {
      dir = risk.cd // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop() ?? null // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(['command', 'exec', 'env', 'nohup', 'time', 'then', 'do', 'else', '!'])

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment: string, dir: string | null, pushed: (string | null)[]): Risk | { cd: string | null } | null {
  const words = tokenize(segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
  const isAssign = (w: string | undefined) => w !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
  while (words.length > 0 && isAssign(words[0])) {
    words.shift() // leading VAR=value
  }
  if (words[0] === 'sudo') {
    words.shift()
    while (words.length > 0 && words[0]!.startsWith('-')) {
      const option = words.shift()!
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift()
      }
    }
  }
  while (words.length > 0 && (PREFIXES.has(words[0]!) || isAssign(words[0]))) {
    words.shift()
  }
  if (words[0] === 'nice') {
    words.shift()
    const option = words[0] as string | undefined
    if (option === '-n') {
      words.splice(0, 2)
    } else if (/^-\d+$/.test(option ?? '')) {
      words.shift()
    }
  }
  const [first, ...args] = words
  if (first === undefined) {
    return null
  }
  const cmd = first.replace(/^\\/, '') // \rm skips aliases; it's still rm
  if (cmd === 'cd') {
    return { cd: args[0] === '-' ? '-' : joinDir(dir, args[0]) }
  }
  if (cmd === 'pushd') {
    pushed.push(dir)
    return { cd: joinDir(dir, args[0]) }
  }
  if (cmd === 'popd') {
    return { cd: pushed.length > 0 ? (pushed.pop() ?? null) : '-' }
  }
  if (cmd === 'rm' || cmd.endsWith('/rm')) {
    const flags = args.filter(a => a.startsWith('-'))
    const recursive = flags.some(f => f === '--recursive' || (/^-[^-]/.test(f) && /[rR]/.test(f)))
    const force = flags.some(f => f === '--force' || (/^-[^-]/.test(f) && f.includes('f')))
    if (recursive || force) {
      const targets = args.filter(a => !a.startsWith('-') || a === '-')
      return { kind: 'rm', label: `rm ${flags.join(' ')}`.trim(), targets, dir }
    }
  }
  if (cmd === 'git') {
    // Git's own options come before the subcommand; -C moves where it runs.
    let gitDir: string | null = dir
    let i = 0
    while (i < args.length && args[i]!.startsWith('-')) {
      if (args[i] === '-C' && i + 1 < args.length) {
        gitDir = joinDir(gitDir, args[i + 1])
        i += 2
      } else if (args[i] === '-c' && i + 1 < args.length) {
        i += 2
      } else {
        i += 1
      }
    }
    const sub = args[i]
    const rest = args.slice(i + 1)
    if (sub === 'reset' && rest.includes('--hard')) {
      return { kind: 'git-reset', label: 'git reset --hard', args: rest, dir: gitDir }
    }
    if (sub === 'clean') {
      return { kind: 'git-clean', label: 'git clean', args: rest, dir: gitDir }
    }
    if (sub === 'push' && rest.some(a => a === '--force' || a === '-f' || a.startsWith('--force-with-lease') || /^\+/.test(a))) {
      return { kind: 'git-push-force', label: 'git push --force', args: rest, dir: gitDir }
    }
    const stagedOnly = sub === 'restore' && rest.includes('--staged') && !rest.includes('--worktree') && !rest.includes('-W')
    if ((sub === 'checkout' || sub === 'restore') && rest.includes('.') && !stagedOnly) {
      return { kind: 'git-checkout', label: `git ${sub} -- .`, args: rest, dir: gitDir }
    }
  }
  const joined = words.join(' ')
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return { kind: 'migrate', tool: 'alembic', label: 'alembic upgrade', dir }
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return { kind: 'migrate', tool: 'rails', label: 'db:migrate', dir }
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return { kind: 'migrate', tool: 'prisma', label: 'prisma migrate', dir }
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return { kind: 'migrate', tool: 'django', label: 'manage.py migrate', dir }
  }
  if (!READ_ONLY.has(cmd) && args.includes('migrate')) {
    return { kind: 'migrate', tool: 'unknown', label: 'migrate', dir }
  }
  return null
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && pwd -P`

async function resolveDir($: EngineInterface, sessionCwd: string, dir: string): Promise<string | null> {
  if (dir === '-') {
    return null // `cd -` depends on the shell's history
  }
  const run = await $.process.run(['bash', '-c', CD_SCRIPT, 'blast-radius', dir], { cwd: sessionCwd, timeoutMs: 5000 })
  const out = run.stdout.trim()
  return run.exitCode === 0 && out !== '' ? out : null
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text: string): string[] {
  const words: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
}

// ---- Measuring the blast radius -------------------------------------------

const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error)

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  try {
    if (risk.kind === 'rm') {
      return await measureRm($, risk, cwd)
    }
    if (risk.kind === 'migrate') {
      return await measureMigrations($, risk, cwd)
    }
    return await measureGit($, risk, cwd)
  } catch (error) {
    return measureFailedReport(risk, error)
  }
}

// ---- Reports: the pane's text, from each tool's output ---------------------
//
// Pure, so the catalog shapes its samples with the same code as a real hold.
// `nothing` marks a report whose command would change nothing.

function missingDirReport(risk: Risk): Report {
  return { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
}

function measureFailedReport(risk: Risk, error: unknown): Report {
  return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${messageOf(error).slice(0, 200)}` }
}

/** From RM_SCRIPT's output: "files bytes found", then up to LIST_MAX paths. */
function rmReport(risk: Risk, stdout: string): Report {
  const targets = risk.targets ?? []
  if (targets.length === 0) {
    return { summary: 'rm with no paths', lines: [], note: 'No paths to expand.', nothing: true }
  }
  const [head, ...rest] = stdout.split('\n').filter(l => l !== '')
  const [files = 0, bytes = 0, found = 0] = (head ?? '0 0 0').split(' ').map(Number)
  if (!found) {
    return { summary: `delete nothing: no file matches ${targets.join(' ')}`, lines: [], note: "The paths don't exist, so rm has nothing to remove.", nothing: true }
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? 'path' : 'paths'} with no files in ${found === 1 ? 'it' : 'them'}`, lines: [], note: `Paths: ${targets.join(' ')}`, nothing: true }
  }
  return {
    summary: `delete ${files} ${files === 1 ? 'file' : 'files'} (about ${size(bytes)})`,
    lines: rest.map(l => l.replace(/^\.\//, '')),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${targets.join(' ')}`,
  }
}

/** From `git clean -n`. */
function cleanReport(run: Run): Report {
  if (run.exitCode !== 0) {
    return { summary: 'git clean (could not dry-run it)', lines: [], note: run.stderr.trim().slice(0, 200) }
  }
  const gone = run.stdout.split('\n').filter(l => l.startsWith('Would remove ')).map(l => l.slice(13))
  return {
    summary: gone.length === 0 ? 'remove nothing: no untracked files match' : `remove ${gone.length} untracked ${gone.length === 1 ? 'path' : 'paths'}`,
    lines: gone.slice(0, LIST_MAX),
    more: Math.max(0, gone.length - LIST_MAX),
    note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    ...(gone.length === 0 ? { nothing: true } : {}),
  }
}

/** From `git status --porcelain` and `git diff --shortstat`, for reset --hard and checkout/restore -- . */
function discardReport(risk: Risk, status: Run, stat: Run | null): Report {
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) }
  }
  const rows = status.stdout.split('\n').filter(l => l.length > 3 && !l.startsWith('??'))
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === 'git-reset' ? rows : rows.filter(l => l[1] !== ' ')
  const shortstat = stat?.stdout.trim() ?? ''
  return {
    summary: lost.length === 0 ? 'discard nothing: no uncommitted changes' : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? 'file' : 'files'}`,
    lines: lost.slice(0, LIST_MAX).map(l => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: shortstat !== '' ? `${shortstat}. Uncommitted changes can't be recovered.` : 'From git status --porcelain.',
    ...(lost.length === 0 ? { nothing: true } : {}),
  }
}

/** From `git rev-parse --verify` of the remote ref and `git log --oneline source..ref`. */
function pushReport(ref: string, source: string, known: Run, log: Run | null): Report {
  if (known.exitCode !== 0 || log === null) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` }
  }
  const dropped = log.stdout.split('\n').filter(l => l !== '')
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? 'commit' : 'commits'}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
    ...(dropped.length === 0 ? { nothing: true } : {}),
  }
}

type Lister = { argv: string[]; pending: (l: string) => boolean; strip: (l: string) => string }

/** From the migration tool's own listing; `lister` undefined when the tool is unknown. */
function migrationReport(risk: Risk, lister: Lister | undefined, run: Run | null): Report {
  if (lister === undefined || run === null) {
    return { summary: 'run migrations', lines: [], note: "I can't list the pending migrations for this tool, so the list is not shown." }
  }
  if (run.exitCode !== 0) {
    return { summary: `run ${risk.label}`, lines: [], note: `Couldn't list pending migrations (${lister.argv.join(' ')} failed).` }
  }
  const pending = run.stdout.split('\n').filter(lister.pending).map(lister.strip)
  return {
    summary: pending.length === 0 ? `run ${risk.label}: nothing pending` : `apply ${pending.length} pending ${pending.length === 1 ? 'migration' : 'migrations'}`,
    lines: pending.slice(0, LIST_MAX),
    more: Math.max(0, pending.length - LIST_MAX),
    note: `From ${lister.argv.join(' ')}.`,
    ...(pending.length === 0 ? { nothing: true } : {}),
  }
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`

async function measureRm($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const targets = risk.targets ?? []
  if (targets.length === 0) {
    return rmReport(risk, '')
  }
  const run = await $.process.run(['bash', '-c', RM_SCRIPT, 'blast-radius', ...targets], { cwd, timeoutMs: 15000 })
  return rmReport(risk, run.stdout)
}

async function measureGit($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const args = risk.args ?? []
  if (risk.kind === 'git-push-force') {
    return await measurePush($, risk, cwd)
  }
  if (risk.kind === 'git-clean') {
    const flags: string[] = []
    const paths: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i]!
      if (a === '--') {
        paths.push(...args.slice(i + 1))
        break
      }
      if (a === '-e' || a === '--exclude') {
        flags.push(a, args[i + 1] ?? '')
        i += 1
      } else if (a.startsWith('--exclude=') || /^-e./.test(a)) {
        flags.push(a)
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, '') // -n is added below; -f, -i and -q would change the dry run
        if (kept !== '-') {
          flags.push(kept)
        }
      } else if (!a.startsWith('-')) {
        paths.push(a)
      }
    }
    const run = await $.process.run(['git', 'clean', '-n', ...flags, '--', ...paths], { cwd, timeoutMs: 15000 })
    return cleanReport(run)
  }
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 15000 })
  if (status.exitCode !== 0) {
    return discardReport(risk, status, null)
  }
  const stat = await $.process.run(['git', 'diff', '--shortstat', risk.kind === 'git-reset' ? 'HEAD' : '--'], { cwd, timeoutMs: 15000 })
  return discardReport(risk, status, stat)
}

async function measurePush($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const positional = (risk.args ?? []).filter(a => !a.startsWith('-'))
  const remote = positional[0] ?? 'origin'
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? '').replace(/^\+/, '')
  let [source = '', branch = ''] = spec.includes(':') ? spec.split(':') : [spec, spec]
  branch = branch.replace(/^refs\/heads\//, '')
  if (!branch || branch === 'HEAD') {
    // No branch, or `git push origin HEAD`: the current branch, to its namesake.
    const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10000 })
    branch = head.stdout.trim()
    source = 'HEAD'
  }
  source = source || 'HEAD'
  const ref = `${remote}/${branch}`
  const known = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd, timeoutMs: 10000 })
  if (known.exitCode !== 0) {
    return pushReport(ref, source, known, null)
  }
  const log = await $.process.run(['git', 'log', '--oneline', '--no-decorate', `${source}..${ref}`], { cwd, timeoutMs: 15000 })
  return pushReport(ref, source, known, log)
}

const MIGRATION_LISTERS: Record<string, Lister> = {
  django: { argv: ['python3', 'manage.py', 'showmigrations', '--plan'], pending: l => l.startsWith('[ ]'), strip: l => l.slice(4) },
  alembic: { argv: ['alembic', 'history', '-r', 'current:head'], pending: l => l.includes('->'), strip: l => l },
  rails: { argv: ['bin/rails', 'db:migrate:status'], pending: l => /^\s*down\b/.test(l), strip: l => l.trim() },
  prisma: { argv: ['npx', '--no-install', 'prisma', 'migrate', 'status'], pending: l => /^\s{2}\S/.test(l), strip: l => l.trim() },
}

async function measureMigrations($: EngineInterface, risk: Risk, cwd: string): Promise<Report> {
  const lister = MIGRATION_LISTERS[risk.tool ?? '']
  if (lister === undefined) {
    return migrationReport(risk, undefined, null)
  }
  let run: Run
  try {
    run = await $.process.run(lister.argv, { cwd, timeoutMs: 20000 })
  } catch (error) {
    run = { exitCode: -1, stdout: '', stderr: messageOf(error) }
  }
  return migrationReport(risk, lister, run)
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = -1
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report: Report): number {
  return Math.min(28, 13 + report.lines.length + (report.more ? 1 : 0))
}

// Each piece takes a kit (the element table, the tone, the surface) and plain
// data, so the pane, the band and the /mods catalog all draw from the same code.

type Child = RenderElement | string | null | undefined | false
type CodeUi = KitUi & { Code: any }

// How serious a hold is: err when it would lose work that can't be got back
// (files, uncommitted changes, untracked files, commits on the remote), warn
// for a migration or a command that would change nothing.
function severityOf(kind: string, report: Report): 'warn' | 'err' {
  return report.nothing || kind === 'migrate' ? 'warn' : 'err'
}

/** "Blast Radius · rm -rf": the kind of risk, in the dialog's title, its icon and colour by severity. */
function titleLine(k: Kit, label: string, tone: 'warn' | 'err'): RenderElement {
  const { Box } = k.ui
  return (
    <Box key="title" flexDirection="row" columnGap={1} alignItems="center">
      {icon(k, tone === 'err' ? 'alert' : 'shield', tone, 16, '⚠')}
      {text(k, `Blast Radius · ${label}`, tone, { bold: true, key: 'title-text' })}
    </Box>
  )
}

// A label at the left of a fact, in the muted tone, its values lined up.
function factRow(k: Kit, key: string, label: string, value: Child): RenderElement {
  const { Box } = k.ui
  return (
    <Box key={key} flexDirection="row" columnGap={1} alignItems="flex-start">
      <Box width={8} flexShrink={0}>
        {text(k, label, 'muted')}
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column">
        {value}
      </Box>
    </Box>
  )
}

/** The held command, as Claude wrote it, in mono with the shell's colours; long ones wrap. */
function commandLine(k: Kit, command: string): RenderElement {
  const { Code } = k.ui as CodeUi
  return factRow(k, 'cmd', 'Command', <Code key="command" source={command} language="bash" wrap="wrap" />)
}

/** What the command would do, in the dialog's colour. */
function wouldLine(k: Kit, summary: string, tone: 'warn' | 'err'): RenderElement {
  return factRow(k, 'sum', 'Would', text(k, summary, tone, { bold: true, key: 'summary' }))
}

/** What it would change: up to LIST_MAX paths, commits or migrations in mono, in a well, then "+ N more". */
function previewList(k: Kit, report: Report): RenderElement | null {
  const { Box, Code } = k.ui as CodeUi
  if (!report.lines.length && !report.more) {
    return null
  }
  return (
    <Box key="list" flexDirection="column">
      {report.lines.length ? (
        <Box flexDirection="column" backgroundColor={k.t.ink.hover} paddingX={1}>
          <Code key="paths" source={report.lines.join('\n')} wrap="truncate-end" />
        </Box>
      ) : null}
      {report.more ? text(k, `+ ${report.more} more`, 'faint', { key: 'more' }) : null}
    </Box>
  )
}

/** Where the numbers came from, or why there are none; muted. */
function noteLine(k: Kit, note: string): RenderElement | null {
  return note ? text(k, note, 'muted', { key: 'note', wrap: 'wrap' }) : null
}

/**
 * Proceed (1) and Cancel (2), with the waiting state. Cancel is the safe
 * default: it has the accent and the focus, so Enter refuses the command;
 * Proceed, the destructive choice, stays a plain button. Once pressed, the
 * buttons give way to what happens next.
 */
function decisionRow(k: Kit, decision: Outcome | null, onProceed: () => void, onCancel: () => void): RenderElement {
  const { Box, Button } = k.ui
  if (decision !== null) {
    return (
      <Box key="buttons" flexDirection="row">
        {status(k, OUTCOMES[decision].word, OUTCOMES[decision].tone)}
      </Box>
    )
  }
  // The terminal draws a plain Button as `1: Proceed`, so its hotkey shows.
  const buttons = k.vector
    ? [
        action(k, 'proceed', 'Proceed', onProceed, { hotkey: '1' }),
        <Button key="cancel" label="Cancel" hotkey="2" variant="primary" autoFocus onPress={onCancel} />,
      ]
    : [
        <Button key="proceed" label="Proceed" hotkey="1" plain onPress={onProceed} />,
        <Button key="cancel" label="Cancel" hotkey="2" plain autoFocus onPress={onCancel} />,
      ]
  return (
    <Box key="buttons" flexDirection="row" columnGap={2} rowGap={0} alignItems="center" flexWrap="wrap">
      <Box flexGrow={1}>{status(k, 'Claude is waiting on your answer', 'muted')}</Box>
      <Box flexDirection="row" columnGap={k.vector ? 1 : 2}>
        {buttons}
      </Box>
    </Box>
  )
}

type DialogArgs = { label: string; kind: string; command: string; report: Report; decision: Outcome | null; onProceed: () => void; onCancel: () => void }

/** The hold dialog: a notice in warn or err by severity, the command, what it would change, and the choice. */
function dialog(k: Kit, { label, kind, command, report, decision, onProceed, onCancel }: DialogArgs): RenderElement {
  const { Box } = k.ui
  const tone = severityOf(kind, report)
  return (
    <Box key="hold" flexDirection="column" borderStyle="round" borderColor={k.t.ink.line} paddingX={1} rowGap={1}>
      {titleLine(k, label, tone)}
      <Box flexDirection="column">
        {commandLine(k, command)}
        {wouldLine(k, report.summary, tone)}
      </Box>
      {previewList(k, report)}
      {noteLine(k, report.note)}
      {decisionRow(k, decision, onProceed, onCancel)}
    </Box>
  )
}

/** A held command's end, as the person sees it: the state, then the full message. */
function outcomeTree(k: Kit, outcome: Outcome, message: string): RenderElement {
  const { Box } = k.ui
  return (
    <Box flexDirection="column">
      {status(k, OUTCOMES[outcome].word, OUTCOMES[outcome].tone)}
      {text(k, message, 'muted', { wrap: 'wrap', key: 'message' })}
    </Box>
  )
}

// ---- The catalog ----------------------------------------------------------
//
// Every component Blast Radius draws, named, for the Components tab of /mods.
// Each sample is a real command read by `classify`, and its report is shaped by
// the same functions as a real hold, from the output its tools would print.
// Then made static: a press cannot cross from the hub to this mod.

const noop = () => {}

// A tree another mod can draw: plain data. A Button's onPress stays in this
// mod, so a Button is drawn as text the way the terminal draws it (`1: Proceed`
// for a plain one, `[ Cancel ]` in the accent for the main one), and every
// function is left out.
function staticTree(k: Kit, node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(n => staticTree(k, n)).filter(n => n !== undefined && n !== null)
  }
  if (node === null || typeof node !== 'object') {
    return typeof node === 'function' ? undefined : node
  }
  const el = node as { type?: string; props?: Record<string, unknown> }
  if (el.type === 'Button') {
    const p = el.props ?? {}
    const label = String(p.label ?? p.key ?? '')
    const { Text } = k.ui
    if (p.plain) {
      return staticTree(k, <Text key={p.key as string}>{p.hotkey ? [<Text color={k.t.ink.accent} bold>{String(p.hotkey)}</Text>, `: ${label}`] : label}</Text>)
    }
    return staticTree(k, <Text key={p.key as string} {...(p.variant === 'primary' ? { color: k.t.ink.accent, bold: true } : {})}>{`[ ${label} ]`}</Text>)
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(el)) {
    if (key === 'press' || typeof v === 'function' || v === undefined) {
      continue
    }
    out[key] =
      key === 'props'
        ? Object.fromEntries(Object.entries((v ?? {}) as object).filter(([, x]) => typeof x !== 'function' && x !== undefined).map(([pk, x]) => [pk, pk === 'children' ? staticTree(k, x) : x]))
        : staticTree(k, v)
  }
  return out
}

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const failed = (stderr: string): Run => ({ exitCode: 1, stdout: '', stderr })

// What each tool would print for the samples.
const SAMPLE = {
  rmOut: [
    '214 3565158 2',
    './dist/index.js', './dist/index.js.map', './dist/cli.js', './dist/cli.js.map', './dist/assets/logo-3f2a9c.svg',
    './dist/assets/app-81be0d.css', './.cache/babel/7c/1f0e2a.json', './.cache/babel/9d/44ab10.json',
    './.cache/eslint/.eslintcache', './.cache/ts/tsbuildinfo',
  ].join('\n'),
  porcelain: ['M  src/api/client.ts', ' M src/app.tsx', 'MM package.json', 'A  src/hooks/useExport.ts', ' D docs/old-setup.md', '?? scratch.txt'].join('\n'),
  shortstat: ' 5 files changed, 48 insertions(+), 17 deletions(-)',
  clean: ['Would remove .env.local', 'Would remove build/', 'Would remove coverage/', 'Would remove notes.txt', 'Would remove src/scratch.ts', 'Would remove tmp/'].join('\n'),
  pushLog: ['a1b2c3d fix: retry flaky uploads', '9e8f7a6 feat: add the export button', '4d5c6b7 docs: update the changelog'].join('\n'),
  showmigrations: ['[X] accounts.0003_profile', '[ ] accounts.0004_add_avatar', '[ ] billing.0012_invoice_due_date', '[ ] billing.0013_backfill_due_dates'].join('\n'),
}

const CATALOG_TEXT: Record<string, { en: [string, string]; pt: [string, string] }> = {
  'hold-rm-rf': {
    en: ['Hold dialog, rm -rf', 'A recursive delete held, in the error colour: how many files and how much space, and the first paths it would remove.'],
    pt: ['Diálogo de espera, rm -rf', 'Uma remoção recursiva segurada, na cor de erro: quantos arquivos, quanto espaço e os primeiros caminhos que sairiam.'],
  },
  'hold-git-reset-hard': {
    en: ['Hold dialog, git reset --hard', "The staged and unstaged changes it would throw away, file by file, with git's line counts."],
    pt: ['Diálogo de espera, git reset --hard', 'As mudanças staged e unstaged que seriam descartadas, arquivo por arquivo, com a contagem de linhas do git.'],
  },
  'hold-git-checkout': {
    en: ['Hold dialog, git checkout -- .', 'The unstaged changes a checkout or restore of the whole tree would drop.'],
    pt: ['Diálogo de espera, git checkout -- .', 'As mudanças unstaged que um checkout ou restore da árvore inteira descartaria.'],
  },
  'hold-git-clean': {
    en: ['Hold dialog, git clean', 'The untracked files and folders it would remove, from a dry run.'],
    pt: ['Diálogo de espera, git clean', 'Os arquivos e pastas não rastreados que seriam removidos, de um dry run.'],
  },
  'hold-force-push': {
    en: ['Hold dialog, force push', 'The commits on the remote branch the push would drop.'],
    pt: ['Diálogo de espera, force push', 'Os commits do branch remoto que o push descartaria.'],
  },
  'hold-migration': {
    en: ['Hold dialog, migration', "The pending migrations it would apply, from the tool's own listing (here Django), in the warning colour."],
    pt: ['Diálogo de espera, migration', 'As migrations pendentes que seriam aplicadas, da listagem da própria ferramenta (aqui Django), na cor de aviso.'],
  },
  'hold-migration-unknown-tool': {
    en: ['Hold dialog, migration with an unknown tool', "A migrate command whose tool Blast Radius can't list, so no list is shown."],
    pt: ['Diálogo de espera, migration de ferramenta desconhecida', 'Um comando migrate cuja ferramenta o Blast Radius não sabe listar, então nenhuma lista aparece.'],
  },
  'hold-migration-nothing-pending': {
    en: ['Hold dialog, no pending migrations', 'A migration with nothing left to apply.'],
    pt: ['Diálogo de espera, nenhuma migration pendente', 'Uma migration sem nada pendente para aplicar.'],
  },
  'hold-migration-list-failed': {
    en: ['Hold dialog, migrations could not be listed', "The tool's listing failed, so only the command is shown."],
    pt: ['Diálogo de espera, migrations não listadas', 'A listagem da ferramenta falhou, então só o comando aparece.'],
  },
  'hold-nothing-to-delete': {
    en: ['Hold dialog, nothing to delete', "rm -rf on paths that don't exist: the warning colour, since nothing would be lost."],
    pt: ['Diálogo de espera, nada para apagar', 'rm -rf em caminhos que não existem: a cor de aviso, já que nada se perderia.'],
  },
  'hold-empty-folders': {
    en: ['Hold dialog, folders with no files', 'rm -rf on paths that exist but hold no files.'],
    pt: ['Diálogo de espera, pastas sem arquivos', 'rm -rf em caminhos que existem mas não têm arquivos.'],
  },
  'hold-rm-no-paths': {
    en: ['Hold dialog, rm with no paths', 'A forced rm with nothing to expand.'],
    pt: ['Diálogo de espera, rm sem caminhos', 'Um rm forçado sem nada para expandir.'],
  },
  'hold-nothing-to-discard': {
    en: ['Hold dialog, nothing to discard', 'git reset --hard on a clean working tree.'],
    pt: ['Diálogo de espera, nada para descartar', 'git reset --hard numa árvore de trabalho limpa.'],
  },
  'hold-nothing-to-clean': {
    en: ['Hold dialog, nothing to clean', 'git clean when no untracked file matches.'],
    pt: ['Diálogo de espera, nada para limpar', 'git clean quando nenhum arquivo não rastreado corresponde.'],
  },
  'hold-force-push-drops-nothing': {
    en: ['Hold dialog, force push that drops nothing', 'A force push whose remote branch has no commits the local one lacks.'],
    pt: ['Diálogo de espera, force push que não descarta nada', 'Um force push cujo branch remoto não tem commits que faltem no local.'],
  },
  'hold-force-push-unknown': {
    en: ['Hold dialog, force push to an unknown branch', "No local copy of the remote branch, so the dropped commits can't be told."],
    pt: ['Diálogo de espera, force push para branch desconhecido', 'Sem cópia local do branch remoto, então não dá para dizer quais commits sairiam.'],
  },
  'hold-not-a-repo': {
    en: ['Hold dialog, not a git repo', 'A git command held outside a repository: git status failed.'],
    pt: ['Diálogo de espera, fora de um repositório git', 'Um comando git segurado fora de um repositório: o git status falhou.'],
  },
  'hold-missing-folder': {
    en: ['Hold dialog, folder not found', "The command cds into a folder that doesn't exist, so nothing could be measured."],
    pt: ['Diálogo de espera, pasta não encontrada', 'O comando entra numa pasta que não existe, então nada pôde ser medido.'],
  },
  'hold-measure-failed': {
    en: ['Hold dialog, could not measure', 'Measuring hit an error; the error is shown as the note.'],
    pt: ['Diálogo de espera, não foi possível medir', 'A medição deu erro; o erro aparece como nota.'],
  },
  'hold-in-band': {
    en: ['Hold dialog in the band, narrow terminal', "When the terminal can't place a pane, the same dialog draws above the prompt."],
    pt: ['Diálogo de espera na faixa, terminal estreito', 'Quando o terminal não consegue abrir um painel, o mesmo diálogo aparece acima do prompt.'],
  },
  'dialog-title': {
    en: ['Dialog title', '"Blast Radius" and the kind of risky command, with the alert icon (err) or the shield (warn).'],
    pt: ['Título do diálogo', '"Blast Radius" e o tipo de comando arriscado, com o ícone de alerta (erro) ou o escudo (aviso).'],
  },
  'command-row': {
    en: ['Command row', 'The held command, as Claude wrote it, in mono with shell colours; a long one wraps.'],
    pt: ['Linha do comando', 'O comando segurado, como o Claude escreveu, em mono com as cores do shell; um comando longo quebra a linha.'],
  },
  'would-row': {
    en: ['"Would" row', "What the command would do, in the dialog's colour."],
    pt: ['Linha "Would"', 'O que o comando faria, na cor do diálogo.'],
  },
  'preview-list': {
    en: ['What it would change', 'Up to 10 paths, commits or migrations in mono, then "+ N more".'],
    pt: ['O que mudaria', 'Até 10 caminhos, commits ou migrations em mono, e depois "+ N more".'],
  },
  'note-line': {
    en: ['Note line', 'Where the numbers came from, or why there are none.'],
    pt: ['Linha de nota', 'De onde vieram os números, ou por que não há nenhum.'],
  },
  'decision-buttons': {
    en: ['Proceed and Cancel buttons', 'Proceed (1), plain, and Cancel (2), the safe default in the accent with the focus, beside "Claude is waiting on your answer".'],
    pt: ['Botões Proceed e Cancel', 'Proceed (1), simples, e Cancel (2), o padrão seguro, em destaque e com o foco, ao lado de "Claude is waiting on your answer".'],
  },
  'decided-proceed': {
    en: ['After Proceed, in the dialog', 'The buttons give way to the state while the pane closes and the command runs.'],
    pt: ['Depois do Proceed, no diálogo', 'Os botões dão lugar ao estado enquanto o painel fecha e o comando roda.'],
  },
  'decided-cancel': {
    en: ['After Cancel, in the dialog', 'The buttons give way to the state while the pane closes; the command is not run.'],
    pt: ['Depois do Cancel, no diálogo', 'Os botões dão lugar ao estado enquanto o painel fecha; o comando não roda.'],
  },
  'toast-proceed': {
    en: ['Toast after Proceed', 'The toast shown as the held command runs.'],
    pt: ['Toast depois do Proceed', 'O toast que aparece quando o comando segurado roda.'],
  },
  'denied-cancel': {
    en: ['Refusal after Cancel', 'The reason shown on the held call, and read by Claude, after Cancel.'],
    pt: ['Recusa depois do Cancel', 'O motivo mostrado na chamada segurada, e lido pelo Claude, depois do Cancel.'],
  },
  'denied-timeout': {
    en: ['Refusal after no answer', 'The reason after 10 minutes with no answer.'],
    pt: ['Recusa sem resposta', 'O motivo depois de 10 minutos sem resposta.'],
  },
  'denied-interrupted': {
    en: ['Refusal after an interrupt', 'The reason when the turn is interrupted while the command is held.'],
    pt: ['Recusa depois de uma interrupção', 'O motivo quando o turno é interrompido com o comando segurado.'],
  },
  'denied-while-queued': {
    en: ['Refusal while waiting behind another hold', 'The reason when the turn is interrupted while this command waits for another held one.'],
    pt: ['Recusa na fila de outra espera', 'O motivo quando o turno é interrompido enquanto este comando espera outro que está segurado.'],
  },
  'denied-error': {
    en: ['Refusal after an error', 'The reason when holding the command hits an error.'],
    pt: ['Recusa depois de um erro', 'O motivo quando segurar o comando dá erro.'],
  },
}

async function catalogOf($: EngineInterface, args: Partial<BlastPanelArgs> | undefined): Promise<BlastCatalogEntry[]> {
  const lang = args?.lang === 'pt' ? 'pt' : 'en'
  const surface: RenderSurface = args?.surface ?? 'terminal'
  const columns = Math.max(40, Number(args?.columns) || 80)
  const tone = toneOf(await skinOf($))
  const k = kitOf($.ui.resolve({ surface, component: 'Pane' } as never) as unknown as KitUi, tone, surface, columns)
  const bandColumns = Math.min(columns, 80)
  const band = kitOf($.ui.resolve({ surface, component: 'AbovePrompt' } as never) as unknown as KitUi, tone, surface, bandColumns)
  const sized = (tree: Child, kit: Kit = k, width = columns) => (
    <kit.ui.Box width={width} flexDirection="column">
      {tree}
    </kit.ui.Box>
  )

  // A sample hold: the command as Claude wrote it, read by `classify`.
  const hold = (command: string, report: (risk: Risk) => Report, decision: Outcome | null = null) => {
    const risk = classify(command)!
    return dialog(k, { label: risk.label, kind: risk.kind, command, report: report(risk), decision, onProceed: noop, onCancel: noop })
  }
  const rm = (command: string, stdout: string) => hold(command, risk => rmReport(risk, stdout))
  const discard = (command: string, porcelain: string, shortstat: string) => hold(command, risk => discardReport(risk, ok(porcelain), ok(shortstat)))
  const migrate = (command: string, run: Run) => hold(command, risk => migrationReport(risk, MIGRATION_LISTERS[risk.tool ?? ''], run))

  const rmRisk = classify('rm -rf dist .cache')!
  const rmSample = rmReport(rmRisk, SAMPLE.rmOut)
  const rmSummary = rmSample.summary

  const trees: Record<string, RenderElement> = {
    'hold-rm-rf': rm('rm -rf dist .cache', SAMPLE.rmOut),
    'hold-git-reset-hard': discard('git reset --hard HEAD', SAMPLE.porcelain, SAMPLE.shortstat),
    'hold-git-checkout': discard('git checkout -- .', SAMPLE.porcelain, ' 3 files changed, 21 insertions(+), 30 deletions(-)'),
    'hold-git-clean': hold('git clean -fdx', () => cleanReport(ok(SAMPLE.clean))),
    'hold-force-push': hold('git push --force origin main', () => pushReport('origin/main', 'main', ok('a1b2c3d'), ok(SAMPLE.pushLog))),
    'hold-migration': migrate('python3 manage.py migrate', ok(SAMPLE.showmigrations)),
    'hold-migration-unknown-tool': migrate('npm run db migrate', ok('')),
    'hold-migration-nothing-pending': migrate('python3 manage.py migrate', ok('[X] accounts.0003_profile\n[X] accounts.0004_add_avatar')),
    'hold-migration-list-failed': migrate('bin/rails db:migrate', failed('rails: command not found')),
    'hold-nothing-to-delete': rm('rm -rf tmp/*.log', '0 0 0'),
    'hold-empty-folders': rm('rm -rf logs cache', '0 8192 2'),
    'hold-rm-no-paths': rm('rm -rf', ''),
    'hold-nothing-to-discard': discard('git reset --hard', '', ''),
    'hold-nothing-to-clean': hold('git clean -fd', () => cleanReport(ok(''))),
    'hold-force-push-drops-nothing': hold('git push -f origin feature/export', () => pushReport('origin/feature/export', 'feature/export', ok('a1b2c3d'), ok(''))),
    'hold-force-push-unknown': hold('git push --force upstream release', () => pushReport('upstream/release', 'release', failed(''), null)),
    'hold-not-a-repo': hold('git reset --hard', risk => discardReport(risk, failed('fatal: not a git repository (or any of the parent directories): .git'), null)),
    'hold-missing-folder': hold('cd packages/old-api && rm -rf node_modules', missingDirReport),
    'hold-measure-failed': hold('rm -rf build', risk => measureFailedReport(risk, new Error('bash: timed out after 15000 ms'))),
    // A pane always has room on a desktop; only a narrow terminal falls back to the band.
    'hold-in-band':
      surface === 'terminal'
        ? sized(dialog(band, { label: rmRisk.label, kind: rmRisk.kind, command: 'rm -rf dist .cache', report: rmSample, decision: null, onProceed: noop, onCancel: noop }), band, bandColumns)
        : text(band, lang === 'pt' ? 'Só num terminal estreito demais para o painel.' : 'Only in a terminal too narrow for the pane.', 'muted'),
    'dialog-title': titleLine(k, rmRisk.label, 'err'),
    'command-row': commandLine(k, 'rm -rf dist .cache'),
    'would-row': wouldLine(k, rmSummary, 'err'),
    'preview-list': previewList(k, rmSample)!,
    'note-line': noteLine(k, rmSample.note)!,
    'decision-buttons': decisionRow(k, null, noop, noop),
    'decided-proceed': decisionRow(k, 'proceed', noop, noop),
    'decided-cancel': decisionRow(k, 'cancel', noop, noop),
    'toast-proceed': status(k, PROCEED_TOAST, 'warn'),
    'denied-cancel': outcomeTree(k, 'cancel', denyMessage('cancel', rmSummary)),
    'denied-timeout': outcomeTree(k, 'timeout', denyMessage('timeout', rmSummary)),
    'denied-interrupted': outcomeTree(k, 'interrupted', denyMessage('interrupted', rmSummary)),
    'denied-while-queued': outcomeTree(k, 'queued', QUEUED_DENY),
    'denied-error': outcomeTree(k, 'error', denyMessage('error', rmSummary)),
  }

  return Object.keys(CATALOG_TEXT).map(id => {
    const [name, help] = CATALOG_TEXT[id]![lang]
    const tree = id === 'hold-in-band' && surface === 'terminal' ? trees[id] : sized(trees[id])
    return { id, name, help, tree: staticTree(k, tree) }
  })
}
