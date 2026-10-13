// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater: records the file edits Claude makes in a turn, then lets you
// step through them in a pane, one diff at a time. It joins the /mods panel as
// `$.replay`, whose `open` action opens the pane, and lists every component it
// draws in the panel's Components tab through `$.replay.catalog`.
//
// Claude Code 2.1.280 function hooks. Load with --plugin-dir.

const PANE_ID = "replay-theater";
const MAX_DIFF_LINES = 12;
const MAX_LCS_LINES = 400;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

// Module state. `pending` fills during a turn; `replay` is the last finished
// turn's steps, the ones the pane shows.
const state = { pending: [], replay: [], index: 0, isOpen: false, inBand: false, turns: 0 };

function relPath(cwd, path) {
  if (!path) return "(unknown file)";
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  return path;
}

function splitLines(text) {
  if (text === undefined || text === null || text === "") return [];
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// A line diff. Small inputs get an LCS diff, so unchanged lines show as
// context; large ones fall back to all-removed then all-added.
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t) => ({ op: "-", t })), ...b.map((t) => ({ op: "+", t }))];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", t: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", t: a[i++] });
    else out.push({ op: "+", t: b[j++] });
  }
  while (i < n) out.push({ op: "-", t: a[i++] });
  while (j < m) out.push({ op: "+", t: b[j++] });
  return trimContext(out);
}

// Keep one line of context around each change, so a long file's Write shows
// the changed lines, not the whole file.
function trimContext(lines) {
  if (!lines.some((l) => l.op !== " ")) return lines.slice(0, MAX_DIFF_LINES);
  const keep = lines.map((l, k) =>
    l.op !== " " || lines[k - 1]?.op && lines[k - 1].op !== " " || lines[k + 1]?.op && lines[k + 1].op !== " ");
  const out = [];
  let skipped = false;
  lines.forEach((l, k) => {
    if (keep[k]) { if (skipped && out.length) out.push({ op: "~", t: "⋯" }); out.push(l); skipped = false; }
    else skipped = true;
  });
  return out;
}

function countChanges(diff) {
  let add = 0, del = 0;
  for (const l of diff) { if (l.op === "+") add++; else if (l.op === "-") del++; }
  return { add, del };
}

// One step of the replay: a tool, the file, the line diff and a short note.
function makeStep(tool, file, oldText, newText, note) {
  return { tool, file, diff: diffLines(oldText, newText), note };
}

// Turns one tool call into one or more steps.
async function stepsFor($, e) {
  let cwd = "";
  try { cwd = await $.session.cwd(); } catch { /* keep the full path */ }
  const file = relPath(cwd, e.file_path);
  if (e.tool === "Edit") {
    return [makeStep("Edit", file, e.old_string, e.new_string, e.replace_all ? "replace all" : "")];
  }
  if (e.tool === "MultiEdit" && Array.isArray(e.edits)) {
    return e.edits.map((ed, k) => makeStep("MultiEdit", file, ed.old_string, ed.new_string, `edit ${k + 1} of ${e.edits.length}`));
  }
  if (e.tool === "Write") {
    let before = "";
    let isNew = true;
    try {
      if (e.file_path && (await $.fs.exists(e.file_path))) {
        before = await $.fs.read(e.file_path);
        isNew = false;
      }
    } catch { /* unreadable: show it as a new file */ }
    return [makeStep("Write", file, before, e.content, isNew ? "new file" : "rewrite")];
  }
  return [];
}

function hintText(n) {
  return `▶ Replay: ${n} edit${n === 1 ? "" : "s"} (press r)`;
}

async function openReplay($) {
  if (!state.replay.length) return false;
  state.index = 0;
  state.isOpen = true;
  // The pane only takes the keyboard while nothing else holds it. Hide the
  // band first (it held the keys if its button was pressed), then open.
  $.ui.invalidate("ui.render");
  await $.clock.sleep(200);
  const rows = Math.min(MAX_DIFF_LINES + 8, 22);
  const placed = await $.ui.open({ id: PANE_ID, title: "Replay Theater", focus: true, closeOnEscape: true, rows, columns: 58 });
  // No room for a pane (a narrow terminal): draw the replay in the band.
  state.inBand = placed?.isPlaced === false;
  $.ui.invalidate("ui.render");
  return true;
}

// ---- Drawing --------------------------------------------------------------
//
// Each builder takes the element table (`ui`) and plain data, so the pane, the
// band and the /mods catalog all draw from the same code.

// The band's diff cap: what fits in the rows the band may take.
function bandDiffLines(maxRows) {
  return Math.max(3, Math.min(MAX_DIFF_LINES, (maxRows || 20) - 7));
}

// The band above the prompt after a turn with edits: the hint and its button.
function hintTree(ui, n, onOpen) {
  const { Box, Text, Button } = ui;
  return Box({
    flexDirection: "row", gap: 2, paddingX: 1,
    children: [
      Text({ color: "magenta", bold: true, children: hintText(n) }),
      Button({ key: "open-replay", label: "Replay", hotkey: "r", onPress: onOpen }),
    ],
  });
}

// Shown when the pane opens on a turn with nothing recorded.
function emptyTree(ui) {
  return ui.Text({ dimColor: true, children: "No edits to replay." });
}

// The header: the title and "step k of n".
function headerRow(ui, k, total) {
  const { Box, Text } = ui;
  return Box({ flexDirection: "row", justifyContent: "space-between", children: [
    Text({ bold: true, color: "magenta", children: "▶ Replay Theater" }),
    Text({ bold: true, children: `step ${k + 1} of ${total}` }),
  ] });
}

// The step list: one cell per step, the current one highlighted.
function stepStrip(ui, total, k) {
  const { Box, Text } = ui;
  const cells = Array.from({ length: total }, (_, n) =>
    Text({ key: `s${n}`, inverse: n === k, color: n === k ? "cyan" : undefined, dimColor: n !== k, children: ` ${n + 1} ` }));
  return Box({ flexDirection: "row", children: cells });
}

// The step's file, cut from the start when it does not fit.
function fileLine(ui, step) {
  return ui.Text({ bold: true, color: "cyan", wrap: "truncate-start", children: step.file });
}

// The tool, its note and the added and removed line counts.
function metaRow(ui, step) {
  const { Box, Text } = ui;
  const { add, del } = countChanges(step.diff);
  return Box({ flexDirection: "row", gap: 2, children: [
    Text({ dimColor: true, children: `${step.tool}${step.note ? " · " + step.note : ""}` }),
    Text({ color: "green", children: `+${add}` }),
    Text({ color: "red", children: `-${del}` }),
  ] });
}

// The diff: green added lines, red removed ones, dim context and "⋯" for a
// skipped run, capped at `maxDiff` lines with "… N more lines" after.
function diffBlock(ui, diff, maxDiff, width) {
  const { Box, Text } = ui;
  const shown = diff.slice(0, maxDiff);
  const rows = shown.map((l, n) => {
    const color = l.op === "+" ? "green" : l.op === "-" ? "red" : undefined;
    const line = `${l.op === "~" ? " " : l.op} ${l.t}`.slice(0, width);
    return Text({ key: `d${n}`, color, dimColor: l.op === " " || l.op === "~", wrap: "truncate-end", children: line });
  });
  if (diff.length > maxDiff) rows.push(Text({ key: "more", dimColor: true, children: `  … ${diff.length - maxDiff} more lines` }));
  if (!shown.length) rows.push(Text({ key: "empty", dimColor: true, children: "  (no line changes)" }));
  return Box({ flexDirection: "column", marginTop: 1, children: rows });
}

// Prev, Next and Close, on the hotkeys p, n and c.
function navRow(ui, onPrev, onNext, onClose) {
  const { Box, Button } = ui;
  return Box({ flexDirection: "row", gap: 2, marginTop: 1, children: [
    Button({ key: "prev", label: "◀ Prev", hotkey: "p", onPress: onPrev }),
    Button({ key: "next", label: "Next ▶", hotkey: "n", autoFocus: true, onPress: onNext }),
    Button({ key: "close", label: "Close", hotkey: "c", onPress: onClose }),
  ] });
}

// The replay view: one step at a time, in a magenta frame. `onGo(to)` moves to
// a step; `onClose` closes it.
function replayTree(ui, { steps, index, width, maxDiff, onGo, onClose }) {
  const total = steps.length;
  if (!total) return emptyTree(ui);
  const k = Math.max(0, Math.min(index, total - 1));
  const step = steps[k];
  return ui.Box({
    flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1,
    children: [
      headerRow(ui, k, total),
      stepStrip(ui, total, k),
      fileLine(ui, step),
      metaRow(ui, step),
      diffBlock(ui, step.diff, maxDiff, width),
      navRow(ui, () => onGo(k - 1), () => onGo(k + 1), onClose),
    ],
  });
}

// The live replay: drawn in the Pane, or in the band above the prompt when the
// surface can't place a pane.
function replayView($, e, inBand) {
  const go = (to) => { state.index = Math.max(0, Math.min(to, state.replay.length - 1)); $.ui.invalidate("ui.render"); };
  const close = () => {
    state.isOpen = false;
    if (!state.inBand) $.ui.close({ id: PANE_ID });
    state.inBand = false;
    $.ui.invalidate("ui.render");
  };
  return replayTree($.ui.resolve(e), {
    steps: state.replay,
    index: state.index,
    width: Math.max(40, (e.bodyColumns || 100) - 4),
    maxDiff: inBand ? bandDiffLines(e.maxRows) : MAX_DIFF_LINES,
    onGo: go,
    onClose: close,
  });
}

// ---- The catalog ----------------------------------------------------------
//
// Every component Replay Theater draws, named, for the Components tab of /mods.
// Drawn from the builders above with sample steps, then made static: a press
// cannot cross from the hub to this mod.

const noop = () => {};

// A tree another mod can draw: plain data. A Button's onPress stays in this
// mod, so a Button is drawn as text the way the terminal draws it (`[ Label ]`,
// inverted when it holds the focus), and every function is left out.
function staticTree(ui, node) {
  if (Array.isArray(node)) return node.map((n) => staticTree(ui, n)).filter((n) => n !== undefined && n !== null);
  if (node === null || typeof node !== "object") return typeof node === "function" ? undefined : node;
  if (node.type === "Button") {
    const p = node.props ?? {};
    const label = String(p.label ?? p.key ?? "");
    const style = { ...(p.dimColor ? { dimColor: true } : {}), ...(p.autoFocus ? { inverse: true } : {}) };
    if (p.plain) {
      return ui.Text({ key: p.key, ...style, children: p.hotkey ? [ui.Text({ color: "suggestion", bold: true, children: p.hotkey }), `: ${label}`] : label });
    }
    return ui.Text({ key: p.key, ...(p.variant === "primary" ? { color: "suggestion" } : {}), ...style, children: `[ ${label} ]` });
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "press" || typeof v === "function" || v === undefined) continue;
    out[k] = k === "props" ? Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => typeof x !== "function" && x !== undefined)) : staticTree(ui, v);
  }
  return out;
}

// A turn that renamed greet to welcome: the sample the catalog replays.
function sampleSteps() {
  const readme = ["# Greeter", "", "Says hello.", "", "## Usage", "", "```ts", "greet('Ada')", "```", "", "## License", "", "MIT"];
  const doc = [
    "# welcome()", "", "Returns a greeting for `name`.", "", "```ts", "welcome('Ada') // 'Welcome, Ada!'", "```", "",
    "## Options", "", "- `name`: who to greet", "- `loud`: shout it", "", "## Since", "", "0.3.0",
  ];
  return [
    makeStep("Edit", "src/greet.ts",
      "export function greet(name: string) {\n  return `Hello, ${name}!`\n}",
      "export function welcome(name: string) {\n  return `Welcome, ${name}!`\n}", ""),
    makeStep("MultiEdit", "src/cli.ts", "import { greet } from './greet'", "import { welcome } from './greet'", "edit 1 of 2"),
    makeStep("MultiEdit", "src/cli.ts", "  console.log(greet(argv[2]))", "  console.log(welcome(argv[2]))", "edit 2 of 2"),
    makeStep("Write", "docs/welcome.md", "", doc.join("\n"), "new file"),
    makeStep("Write", "README.md", readme.join("\n"),
      ["# Welcomer", ...readme.slice(1, 7), "welcome('Ada')", ...readme.slice(8, 12), "Apache-2.0"].join("\n"), "rewrite"),
    makeStep("Write", "src/.keep", "", "", "new file"),
    makeStep("Edit", "test/greet.test.ts", "greet(", "welcome(", "replace all"),
  ];
}

const CATALOG_TEXT = {
  "band-hint": {
    en: ["Replay hint above the prompt", "After a turn that edited files: the edit count and the Replay button (r)."],
    pt: ["Aviso de replay acima do prompt", "Depois de um turno com edições: quantas edições e o botão Replay (r)."],
  },
  "pane-first-step": {
    en: ["Replay pane, first step (an Edit)", "The pane on step 1: header, step strip, file, counts, diff and buttons."],
    pt: ["Painel do replay, primeiro passo (um Edit)", "O painel no passo 1: cabeçalho, faixa de passos, arquivo, contagem, diff e botões."],
  },
  "pane-multiedit-step": {
    en: ["Replay pane, a MultiEdit step", "One edit of a MultiEdit, noted as \"edit 2 of 2\"."],
    pt: ["Painel do replay, passo de MultiEdit", "Uma edição de um MultiEdit, marcada como \"edit 2 of 2\"."],
  },
  "pane-write-new-file": {
    en: ["Replay pane, a Write of a new file", "A new file: every line added, capped at 12 lines then \"… N more lines\"."],
    pt: ["Painel do replay, Write de arquivo novo", "Um arquivo novo: todas as linhas adicionadas, até 12 linhas e depois \"… N more lines\"."],
  },
  "pane-write-rewrite": {
    en: ["Replay pane, a Write that rewrites a file", "A rewrite: one line of context around each change, a skipped run as \"⋯\"."],
    pt: ["Painel do replay, Write que reescreve um arquivo", "Uma reescrita: uma linha de contexto em volta de cada mudança, trechos pulados como \"⋯\"."],
  },
  "pane-no-line-changes": {
    en: ["Replay pane, a step with no line changes", "A step whose diff is empty, such as a Write of an empty file."],
    pt: ["Painel do replay, passo sem mudança de linhas", "Um passo com diff vazio, como um Write de um arquivo vazio."],
  },
  "pane-last-step": {
    en: ["Replay pane, last step", "The last step highlighted in the strip, here an Edit with replace all."],
    pt: ["Painel do replay, último passo", "O último passo destacado na faixa, aqui um Edit com replace all."],
  },
  "pane-no-edits": {
    en: ["Replay pane, nothing to replay", "What the pane says when the turn recorded no edits."],
    pt: ["Painel do replay, nada para rever", "O que o painel diz quando o turno não registrou edições."],
  },
  "pane-header": {
    en: ["Pane header", "\"▶ Replay Theater\" and \"step k of n\"."],
    pt: ["Cabeçalho do painel", "\"▶ Replay Theater\" e \"step k of n\"."],
  },
  "step-strip": {
    en: ["Step strip", "One numbered cell per edit, the current one highlighted in cyan."],
    pt: ["Faixa de passos", "Uma célula numerada por edição, a atual destacada em ciano."],
  },
  "step-file-and-counts": {
    en: ["Step file and counts", "The file path, the tool and its note, and the added (+) and removed (-) line counts."],
    pt: ["Arquivo e contagem do passo", "O caminho do arquivo, a ferramenta e sua nota, e as linhas adicionadas (+) e removidas (-)."],
  },
  "diff-lines": {
    en: ["Diff lines", "Removed lines in red, added lines in green, unchanged context dim."],
    pt: ["Linhas do diff", "Linhas removidas em vermelho, adicionadas em verde, contexto sem mudança esmaecido."],
  },
  "diff-skipped-run": {
    en: ["Skipped run marker", "\"⋯\" where unchanged lines between two changes are left out."],
    pt: ["Marcador de trecho pulado", "\"⋯\" onde as linhas sem mudança entre duas alterações ficam de fora."],
  },
  "diff-more-lines": {
    en: ["More lines notice", "\"… N more lines\" under a diff longer than the cap."],
    pt: ["Aviso de mais linhas", "\"… N more lines\" embaixo de um diff maior que o limite."],
  },
  "diff-no-line-changes": {
    en: ["No line changes notice", "\"(no line changes)\" for a step with an empty diff."],
    pt: ["Aviso de nenhuma mudança", "\"(no line changes)\" para um passo com diff vazio."],
  },
  "nav-buttons": {
    en: ["Navigation buttons", "◀ Prev (p), Next ▶ (n, focused first) and Close (c)."],
    pt: ["Botões de navegação", "◀ Prev (p), Next ▶ (n, com o foco primeiro) e Close (c)."],
  },
  "band-replay-narrow": {
    en: ["Replay in the band, narrow terminal", "When the terminal can't place a pane (80 columns), the replay draws above the prompt with a shorter diff."],
    pt: ["Replay na faixa, terminal estreito", "Quando o terminal não consegue abrir um painel (80 colunas), o replay aparece acima do prompt com um diff menor."],
  },
};

function catalogOf($, args) {
  const lang = args?.lang === "pt" ? "pt" : "en";
  const surface = args?.surface ?? "terminal";
  const columns = Math.max(40, Number(args?.columns) || 80);
  const pane = $.ui.resolve({ surface, component: "Pane" });
  const band = $.ui.resolve({ surface, component: "AbovePrompt" });
  const steps = sampleSteps();
  const width = Math.max(40, columns - 4);
  const at = (index, maxDiff = MAX_DIFF_LINES, ui = pane, w = width) =>
    replayTree(ui, { steps, index, width: w, maxDiff, onGo: noop, onClose: noop });
  const lines = (diff, maxDiff = MAX_DIFF_LINES) => pane.Box({ width: columns, children: [diffBlock(pane, diff, maxDiff, width)] });
  const sized = (tree) => pane.Box({ width: columns, flexDirection: "column", children: [tree] });

  // A gap and an overflow, each on its own, from the sample's diffs.
  const gap = steps[4].diff;
  const gapAt = gap.findIndex((l) => l.op === "~");

  const trees = {
    "band-hint": band.Box({ width: columns, children: [hintTree(band, steps.length, noop)] }),
    "pane-first-step": sized(at(0)),
    "pane-multiedit-step": sized(at(2)),
    "pane-write-new-file": sized(at(3)),
    "pane-write-rewrite": sized(at(4)),
    "pane-no-line-changes": sized(at(5)),
    "pane-last-step": sized(at(steps.length - 1)),
    "pane-no-edits": sized(replayTree(pane, { steps: [], index: 0, width, maxDiff: MAX_DIFF_LINES, onGo: noop, onClose: noop })),
    "pane-header": sized(headerRow(pane, 1, steps.length)),
    "step-strip": sized(stepStrip(pane, steps.length, 1)),
    "step-file-and-counts": sized(pane.Box({ flexDirection: "column", children: [fileLine(pane, steps[0]), metaRow(pane, steps[0])] })),
    "diff-lines": lines(steps[0].diff),
    "diff-skipped-run": lines(gap.slice(Math.max(0, gapAt - 2), gapAt + 3)),
    "diff-more-lines": lines(steps[3].diff.slice(0, 6), 3),
    "diff-no-line-changes": lines([]),
    "nav-buttons": sized(navRow(pane, noop, noop, noop)),
    // A pane always has room on a desktop; only a narrow terminal falls back to
    // the band, where the diff is cut to the rows the band has (5 of 12 here).
    "band-replay-narrow": surface === "terminal"
      ? band.Box({ width: Math.min(columns, 80), children: [at(3, bandDiffLines(12), band, Math.min(columns, 80) - 4)] })
      : band.Text({ dimColor: true, children: lang === "pt" ? "Só num terminal estreito demais para o painel." : "Only in a terminal too narrow for the pane." }),
  };

  return Object.keys(CATALOG_TEXT).map((id) => {
    const [name, help] = CATALOG_TEXT[id][lang];
    return { id, name, help, tree: staticTree(pane, trees[id]) };
  });
}

// The hub's /mods panel. `lang` is the hub's; anything but 'pt' is English.
const TEXT = {
  en: {
    title: "Replay",
    section: "Last turn",
    edits: (n) => (n ? `${n} edit${n === 1 ? "" : "s"} in the last turn` : "no edits yet"),
    open: "Replay the last turn",
    openHelp: "Opens the Replay Theater pane",
    explain: "Steps through the file edits Claude made in the last turn, one diff at a time: n next, p previous, c close.",
    nothing: "Replay Theater: no edits in the last turn to replay.",
  },
  pt: {
    title: "Replay",
    section: "Último turno",
    edits: (n) => (n ? `${n} ${n === 1 ? "edição" : "edições"} no último turno` : "nenhuma edição ainda"),
    open: "Rever o último turno",
    openHelp: "Abre o painel do Replay Theater",
    explain: "Percorre as edições de arquivo que o Claude fez no último turno, um diff por vez: n próximo, p anterior, c fechar.",
    nothing: "Replay Theater: nenhuma edição no último turno para rever.",
  },
};

// The act carries no `lang`, so it answers in the one the last panel asked for.
let lastLang = "en";

function textOf(lang) {
  return lang === "pt" ? TEXT.pt : TEXT.en;
}

function panelOf(args) {
  lastLang = args?.lang === "pt" ? "pt" : "en";
  const t = textOf(lastLang);
  const n = state.replay.length;
  return {
    title: t.title,
    summary: t.edits(n),
    tone: n ? "accent" : "muted",
    sections: [{
      id: "last-turn",
      title: t.section,
      items: [
        { kind: "action", id: "open", label: t.open, help: t.openHelp, primary: true },
        { kind: "text", text: t.explain, tone: "muted" },
      ],
    }],
  };
}

async function actOn($, args) {
  if (args?.id !== "open") return {};
  if (!state.replay.length) return { message: textOf(lastLang).nothing };
  await openReplay($);
  return {};
}

export function register(on, options) {
  // Adds `$.replay` for the hub's /mods panel. A call is the `replay.panel`,
  // `replay.act` or `replay.catalog` event, which the hooks below answer; the
  // stub is the floor.
  on("engine.create", async ($, e, next) => {
    const built = await next(e);
    return {
      ...built,
      replay: { panel: async () => ({ title: "", sections: [] }), act: async () => ({}), catalog: async () => [] },
    };
  });

  on("replay.panel", async ($, e) => ({ value: panelOf(e) }));
  on("replay.act", async ($, e) => ({ value: await actOn($, e) }));
  on("replay.catalog", async ($, e) => ({ value: catalogOf($, e) }));

  // Record each edit, then let it run. Never blocks the call.
  on("tool.call", async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      try {
        const steps = await stepsFor($, e);
        state.pending.push(...steps);
      } catch { /* recording must never stop the edit */ }
    }
    return next(e);
  });

  on("turn.start", ($, e, next) => {
    if (!e.agentId) state.pending = [];
    return next(e);
  });

  // At the end of a main-loop turn, the pending edits become the replay.
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !state.pending.length) return r;
    state.replay = state.pending;
    state.pending = [];
    state.index = 0;
    state.turns++;
    $.ui.invalidate("ui.render");
    return r;
  });

  // The band above the prompt: the hint and a button that opens the pane.
  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (state.isOpen && state.inBand) return replayView($, e, true);
    if (!state.replay.length || state.isOpen) return next(e);
    return hintTree($.ui.resolve(e), state.replay.length, () => openReplay($));
  });

  // The pane.
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return replayView($, e, false);
  });

  // The person closed the pane (Escape): keep our flag in step.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) state.isOpen = false;
    $.ui.invalidate("ui.render");
    return next(e);
  });
}
