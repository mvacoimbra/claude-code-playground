// The contract of `$.blast`: Blast Radius's components in the Components tab of the /mods panel.
// It has no tab of its own there, so the noun has only `catalog`.

export type BlastLang = 'en' | 'pt'
export type BlastPanelArgs = { lang: BlastLang; surface: 'terminal' | 'desktop' | 'vscode' | 'mobile'; columns: number }
// One component Blast Radius draws, for the Components tab of /mods.
export type BlastCatalogEntry = {
  // Stable, kebab-case: what a person names when asking for a change.
  id: string
  // The component's name, as a person would say it ("Hold dialog, rm -rf").
  name: string
  // One line on what it is and where it shows.
  help?: string
  // The component drawn for `args.surface` at `args.columns`, from the same builders the mod
  // draws it with in place, in a state worth seeing. Static: a press cannot cross to the mod.
  tree: unknown
}

declare module 'claude-code' {
  interface EngineInterface {
    blast: {
      catalog: (args: BlastPanelArgs) => Promise<BlastCatalogEntry[]>
    }
  }
}
