// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater: records the file edits Claude makes in a turn, then lets you
// step through them in a pane, one diff at a time. It joins the /mods panel as
// `$.replay`, whose `open` action opens the pane.
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
// Each builder takes the element table (`ui`) and plain data, so the pane and
// the band draw from the same code.

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
  // Adds `$.replay` for the hub's /mods panel. A call is the `replay.panel` or
  // `replay.act` event, which the hooks below answer; the stub is the floor.
  on("engine.create", async ($, e, next) => {
    const built = await next(e);
    return { ...built, replay: { panel: async () => ({ title: "", sections: [] }), act: async () => ({}) } };
  });

  on("replay.panel", async ($, e) => ({ value: panelOf(e) }));
  on("replay.act", async ($, e) => ({ value: await actOn($, e) }));

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
