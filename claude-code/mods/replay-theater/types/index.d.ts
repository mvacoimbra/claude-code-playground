// The contract of `$.replay`: Replay Theater's tab in the /mods panel, and its components
// in the panel's Components tab.

export type ReplayLang = 'en' | 'pt'
export type ReplayPanelArgs = { lang: ReplayLang; surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'; columns: number }
export type ReplayTone = 'ok' | 'warn' | 'err' | 'muted' | 'accent'
// Where a setting lives: the user's (every session and project, the default) or this session's
// alone. The hub marks the session's.
export type ReplayScope = 'user' | 'session'
export type ReplayItem =
  | { kind: 'toggle'; id: string; label: string; help?: string; value: boolean; scope?: ReplayScope }
  | { kind: 'choice'; id: string; label: string; help?: string; value: string; options: { value: string; label: string }[]; scope?: ReplayScope }
  // `label` is the button's; `title`, when given, names the row, with `help` under it.
  | { kind: 'action'; id: string; label: string; title?: string; help?: string; primary?: boolean; scope?: ReplayScope }
  | { kind: 'input'; id: string; label: string; help?: string; placeholder?: string; submitLabel?: string; scope?: ReplayScope }
  | { kind: 'info'; label: string; value: string; tone?: ReplayTone }
  | { kind: 'text'; text: string; tone?: ReplayTone }
  | { kind: 'swatch'; id: string; label: string; color: string; selected: boolean }
  | { kind: 'tree'; tree: unknown }
export type ReplaySection = { id: string; title: string; items: ReplayItem[] }
export type ReplayPanel = {
  // The tab's name.
  title: string
  // One line for the overview and under the tab row.
  summary?: string
  tone?: ReplayTone
  // Drawn as sub-tabs when there is more than one.
  sections: ReplaySection[]
  // While this tab shows, the hub draws it again this often (a countdown).
  refreshMs?: number
}
// `open` opens the Replay Theater pane on the last turn's edits.
export type ReplayActArgs = { id: string; value?: string }
// `message` only when there is nothing to replay.
export type ReplayActResult = { message?: string }
// One component Replay Theater draws, for the Components tab of /mods.
export type ReplayCatalogEntry = {
  // Stable, kebab-case: what a person names when asking for a change.
  id: string
  // The component's name, as a person would say it ("Replay pane, first step").
  name: string
  // One line on what it is and where it shows.
  help?: string
  // The component drawn for `args.surface` at `args.columns`, from the same builders the mod
  // draws it with in place, in a state worth seeing. Static: a press cannot cross to the mod.
  tree: unknown
}

declare module 'claude-code' {
  interface EngineInterface {
    replay: {
      panel: (args: ReplayPanelArgs) => Promise<ReplayPanel>
      act: (args: ReplayActArgs) => Promise<ReplayActResult>
      catalog: (args: ReplayPanelArgs) => Promise<ReplayCatalogEntry[]>
    }
  }
}
