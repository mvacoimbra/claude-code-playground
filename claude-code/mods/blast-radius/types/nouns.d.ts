// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// The noun of another mod that Blast Radius calls, for the editor and tsc only: skins hands
// out the skin every mod of the pack wears. Not this mod's contract (that is index.d.ts).
import type { KitSkin } from '../hooks/kit/tone'

declare module 'claude-code' {
  interface EngineInterface {
    skins: { palette: () => Promise<KitSkin> }
  }
}
