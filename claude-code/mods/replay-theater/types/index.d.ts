// The contract of `$.replay`: Replay Theater's tab in the /mods panel.

export type ReplayLang = 'en' | 'pt'
export type ReplayPanelArgs = { lang: ReplayLang; surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'; columns: number }
export type ReplayTone = 'ok' | 'warn' | 'err' | 'muted' | 'accent'
export type ReplayItem =
  | { kind: 'toggle'; id: string; label: string; help?: string; value: boolean }
  | { kind: 'choice'; id: string; label: string; help?: string; value: string; options: { value: string; label: string }[] }
  | { kind: 'action'; id: string; label: string; help?: string; primary?: boolean }
  | { kind: 'input'; id: string; label: string; help?: string; placeholder?: string; submitLabel?: string }
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

declare module 'claude-code' {
  interface EngineInterface {
    replay: {
      panel: (args: ReplayPanelArgs) => Promise<ReplayPanel>
      act: (args: ReplayActArgs) => Promise<ReplayActResult>
    }
  }
}
