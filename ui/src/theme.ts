// Theme presets — switchable color themes (settings panel / prefs.theme).
// A preset carries THREE faces, all driven from its canonical palette:
//   chrome  — CSS custom properties on body[data-theme] (glass tokens etc.)
//   term    — the xterm.js ITheme (16 ANSI colors + bg/fg/cursor/selection)
//   editor  — a CodeMirror theme (EditorView chrome + HighlightStyle syntax)
//
// Palettes are verbatim from the upstream projects (see ui/src/style.css's
// theme blocks for the chrome-side values and PRESETS below for term/editor).

import { EditorView } from '@codemirror/view';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { ITheme } from '@xterm/xterm';

export interface EditorPalette {
  background: string;
  foreground: string;
  gutter: string;
  selection: string;
  cursor: string;
  activeLine: string;
  keyword: string;
  /** Control-flow keyword when it differs from `keyword` (VS Code's split). */
  control?: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  type: string;
  operator: string;
  punctuation: string;
  property: string;
  variable: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  dark: boolean;
  term: ITheme;
  editor: EditorPalette;
}

/** The CM theme extension is one compartment so a preset swap reconfigures
 * every live editor and detached buffer state in place. */
export const cmThemeSlot = new Compartment();

export function cmThemeFor(p: ThemePreset): Extension {
  const e = p.editor;
  return [
    EditorView.theme(
      {
        '&': { backgroundColor: e.background, color: e.foreground },
        '.cm-gutters': { backgroundColor: e.background, color: e.gutter, border: 'none' },
        '.cm-activeLine': { backgroundColor: e.activeLine },
        '.cm-activeLineGutter': { backgroundColor: e.activeLine },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
          { backgroundColor: `${e.selection} !important` },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: e.cursor },
      },
      { dark: p.dark },
    ),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: e.keyword },
        { tag: t.controlKeyword, color: e.control ?? e.keyword },
        { tag: [t.string, t.special(t.string), t.regexp], color: e.string },
        { tag: [t.comment, t.blockComment, t.lineComment], color: e.comment, fontStyle: 'italic' },
        { tag: [t.number, t.bool, t.null], color: e.number },
        { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: e.function },
        { tag: [t.typeName, t.className, t.namespace, t.tagName], color: e.type },
        { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], color: e.operator },
        { tag: [t.punctuation, t.paren, t.brace, t.bracket, t.squareBracket, t.angleBracket, t.separator], color: e.punctuation },
        { tag: [t.propertyName, t.attributeName, t.labelName], color: e.property },
        { tag: [t.variableName, t.local(t.variableName), t.definition(t.variableName)], color: e.variable },
        { tag: [t.constant(t.variableName), t.atom, t.character, t.escape], color: e.number },
      ]),
    ),
  ];
}

/** Reconfigure the CM theme slot inside any EditorState (view or detached). */
export function rethemeState(state: EditorState, preset: ThemePreset): EditorState {
  return state.update({ effects: cmThemeSlot.reconfigure(cmThemeFor(preset)) }).state;
}

// ---- presets ---------------------------------------------------------------
// Palettes verified against upstream sources:
//   tokyonight.nvim colors/*.lua + extras/alacritty/*.toml
//   catppuccin/palette palette.json (+ kitty port)
//   morhetz/gruvbox colors/gruvbox.vim (incl. g:terminal_color_*)
//   nordtheme.com + nordtheme/alacritty
//   draculatheme.com/contribute + spec.draculatheme.com
//   atom one-dark-syntax colors.less + alacritty-theme one_dark.toml

const MYMUX_NIGHT: ThemePreset = {
  id: 'mymux-night',
  name: 'mymux night (default)',
  dark: true,
  term: {
    background: '#0b0e14',
    foreground: '#c5cdd9',
    cursor: '#c5cdd9',
    selectionBackground: '#26435f',
    black: '#0b0e14',
    red: '#f85149',
    green: '#3fb950',
    yellow: '#d6a04c',
    blue: '#409cff',
    magenta: '#a371f7',
    cyan: '#79c0ff',
    white: '#c5cdd9',
    brightBlack: '#5c6773',
    brightRed: '#ffa198',
    brightGreen: '#7ee787',
    brightYellow: '#e9c362',
    brightBlue: '#79c0ff',
    brightMagenta: '#c0a7f5',
    brightCyan: '#a5d6ff',
    brightWhite: '#e6edf3',
  },
  editor: {
    background: '#0b0e14',
    foreground: '#c5cdd9',
    gutter: '#5c6773',
    selection: '#26435f',
    cursor: '#c5cdd9',
    activeLine: '#11151f',
    keyword: '#ff7b72',
    string: '#a5d6ff',
    comment: '#5c6773',
    number: '#79c0ff',
    function: '#d2a8ff',
    type: '#ffa657',
    operator: '#ff7b72',
    punctuation: '#c5cdd9',
    property: '#79c0ff',
    variable: '#c5cdd9',
  },
};

const TOKYO_NIGHT: ThemePreset = {
  id: 'tokyo-night',
  name: 'Tokyo Night',
  dark: true,
  term: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    selectionBackground: '#283457',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#ff899d',
    brightGreen: '#9fe044',
    brightYellow: '#faba4a',
    brightBlue: '#8db0ff',
    brightMagenta: '#c7a9ff',
    brightCyan: '#a4daff',
    brightWhite: '#c0caf5',
  },
  editor: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    gutter: '#3b4261',
    selection: '#283457',
    cursor: '#c0caf5',
    activeLine: '#1f2335',
    keyword: '#bb9af7',
    string: '#9ece6a',
    comment: '#565f89',
    number: '#ff9e64',
    function: '#7aa2f7',
    type: '#7dcfff',
    operator: '#89ddff',
    punctuation: '#c0caf5',
    property: '#73daca',
    variable: '#c0caf5',
  },
};

const TOKYO_STORM: ThemePreset = {
  ...TOKYO_NIGHT,
  id: 'tokyo-storm',
  name: 'Tokyo Storm',
  term: {
    ...TOKYO_NIGHT.term,
    background: '#24283b',
    black: '#1d202f',
  },
  editor: {
    ...TOKYO_NIGHT.editor,
    background: '#24283b',
  },
};

const CATPPUCCIN_MOCHA: ThemePreset = {
  id: 'catppuccin-mocha',
  name: 'Catppuccin Mocha',
  dark: true,
  term: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#a6adc8',
    brightBlack: '#585b70',
    brightRed: '#f37799',
    brightGreen: '#89d88b',
    brightYellow: '#ebd391',
    brightBlue: '#74a8fc',
    brightMagenta: '#f2aede',
    brightCyan: '#6bd7ca',
    brightWhite: '#bac2de',
  },
  editor: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    gutter: '#6c7086',
    selection: '#45475a',
    cursor: '#f5e0dc',
    activeLine: '#313244',
    keyword: '#cba6f7',
    string: '#a6e3a1',
    comment: '#7f849c',
    number: '#fab387',
    function: '#89b4fa',
    type: '#f9e2af',
    operator: '#89dceb',
    punctuation: '#bac2de',
    property: '#94e2d5',
    variable: '#cdd6f4',
  },
};

const CATPPUCCIN_LATTE: ThemePreset = {
  id: 'catppuccin-latte',
  name: 'Catppuccin Latte (light)',
  dark: false,
  term: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    selectionBackground: '#ccd0da',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#acb0be',
    brightBlack: '#6c6f85',
    brightRed: '#de293e',
    brightGreen: '#49af3d',
    brightYellow: '#eea02d',
    brightBlue: '#456eff',
    brightMagenta: '#fe85d8',
    brightCyan: '#2d9fa8',
    brightWhite: '#bcc0cc',
  },
  editor: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    gutter: '#9ca0b0',
    selection: '#ccd0da',
    cursor: '#dc8a78',
    activeLine: '#e6e9ef',
    keyword: '#8839ef',
    string: '#40a02b',
    comment: '#8c8fa1',
    number: '#fe640b',
    function: '#1e66f5',
    type: '#df8e1d',
    operator: '#04a5e5',
    punctuation: '#5c5f77',
    property: '#179299',
    variable: '#4c4f69',
  },
};

const GRUVBOX_DARK: ThemePreset = {
  id: 'gruvbox-dark',
  name: 'Gruvbox Dark',
  dark: true,
  term: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  editor: {
    background: '#282828',
    foreground: '#ebdbb2',
    gutter: '#7c6f64',
    selection: '#3c3836',
    cursor: '#ebdbb2',
    activeLine: '#32302f',
    keyword: '#fb4934',
    string: '#b8bb26',
    comment: '#928374',
    number: '#d3869b',
    function: '#b8bb26',
    type: '#fabd2f',
    operator: '#ebdbb2',
    punctuation: '#ebdbb2',
    property: '#83a598',
    variable: '#ebdbb2',
  },
};

const NORD: ThemePreset = {
  id: 'nord',
  name: 'Nord',
  dark: true,
  term: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#4c566a',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  editor: {
    background: '#2e3440',
    foreground: '#d8dee9',
    gutter: '#4c566a',
    selection: '#434c5e',
    cursor: '#d8dee9',
    activeLine: '#3b4252',
    keyword: '#81a1c1',
    string: '#a3be8c',
    comment: '#4c566a',
    number: '#b48ead',
    function: '#88c0d0',
    type: '#8fbcbb',
    operator: '#81a1c1',
    punctuation: '#eceff4',
    property: '#8fbcbb',
    variable: '#d8dee9',
  },
};

const DRACULA: ThemePreset = {
  id: 'dracula',
  name: 'Dracula',
  dark: true,
  term: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  editor: {
    background: '#282a36',
    foreground: '#f8f8f2',
    gutter: '#6272a4',
    selection: '#44475a',
    cursor: '#f8f8f2',
    activeLine: '#44475a',
    keyword: '#ff79c6',
    string: '#f1fa8c',
    comment: '#6272a4',
    number: '#bd93f9',
    function: '#50fa7b',
    type: '#8be9fd',
    operator: '#ff79c6',
    punctuation: '#f8f8f2',
    property: '#8be9fd',
    variable: '#f8f8f2',
  },
};

const ONE_DARK: ThemePreset = {
  id: 'one-dark',
  name: 'One Dark',
  dark: true,
  term: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    selectionBackground: '#3e4451',
    black: '#1e2127',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#d19a66',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#e06c75',
    brightGreen: '#98c379',
    brightYellow: '#d19a66',
    brightBlue: '#61afef',
    brightMagenta: '#c678dd',
    brightCyan: '#56b6c2',
    brightWhite: '#ffffff',
  },
  editor: {
    background: '#282c34',
    foreground: '#abb2bf',
    gutter: '#5c6370',
    selection: '#3e4451',
    cursor: '#528bff',
    activeLine: '#2c313c',
    keyword: '#c678dd',
    string: '#98c379',
    comment: '#5c6370',
    number: '#d19a66',
    function: '#61afef',
    type: '#e5c07b',
    operator: '#abb2bf',
    punctuation: '#abb2bf',
    property: '#e06c75',
    variable: '#abb2bf',
  },
};

// Palettes from the VS Code repo (MIT — extensions/theme-defaults/themes/
// {dark,light}_{modern,plus,vs}.json + terminalColorRegistry.ts), named
// descriptively. Token split preserved: keyword vs control-flow keyword.
const CODE_DARK: ThemePreset = {
  id: 'code-dark-modern',
  name: 'Code Dark Modern',
  dark: true,
  term: {
    background: '#181818',
    foreground: '#cccccc',
    cursor: '#aeafad',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  editor: {
    background: '#1f1f1f',
    foreground: '#cccccc',
    gutter: '#6e7681',
    selection: '#264f78',
    cursor: '#aeafad',
    activeLine: '#2a2d2e',
    keyword: '#569cd6',
    control: '#c586c0',
    string: '#ce9178',
    comment: '#6a9955',
    number: '#b5cea8',
    function: '#dcdcaa',
    type: '#4ec9b0',
    operator: '#d4d4d4',
    punctuation: '#cccccc',
    property: '#9cdcfe',
    variable: '#9cdcfe',
  },
};

const CODE_LIGHT: ThemePreset = {
  id: 'code-light-modern',
  name: 'Code Light Modern',
  dark: false,
  term: {
    background: '#f8f8f8',
    foreground: '#3b3b3b',
    cursor: '#3b3b3b',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#107c10',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
  editor: {
    background: '#ffffff',
    foreground: '#3b3b3b',
    gutter: '#237893',
    selection: '#add6ff',
    cursor: '#3b3b3b',
    activeLine: '#f3f3f3',
    keyword: '#0000ff',
    control: '#af00db',
    string: '#a31515',
    comment: '#008000',
    number: '#098658',
    function: '#795e26',
    type: '#267f99',
    operator: '#000000',
    punctuation: '#3b3b3b',
    property: '#e50000',
    variable: '#001080',
  },
};

export const PRESETS: ThemePreset[] = [
  MYMUX_NIGHT,
  TOKYO_NIGHT,
  TOKYO_STORM,
  CATPPUCCIN_MOCHA,
  CATPPUCCIN_LATTE,
  GRUVBOX_DARK,
  NORD,
  DRACULA,
  ONE_DARK,
  CODE_DARK,
  CODE_LIGHT,
];

export function presetById(id: string | undefined): ThemePreset {
  return PRESETS.find((p) => p.id === id) ?? MYMUX_NIGHT;
}

export const DEFAULT_THEME = MYMUX_NIGHT.id;
