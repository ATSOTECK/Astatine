import { alpha, createTheme, type Theme } from '@mui/material/styles';

/**
 * Selectable colour themes. Each one defines the few colours the app uses;
 * everything else (hover states, contrast text…) is derived by MUI.
 * PDF pages are always shown as they are, on white.
 */
export interface ThemeDefinition {
  id: string;
  name: string;
  mode: 'light' | 'dark';
  /** Accent: buttons, selection outlines, focus. */
  primary: string;
  secondary: string;
  /** Area behind the pages. */
  backdrop: string;
  /** Toolbars, menus, dialogs. */
  surface: string;
  text: string;
  textSecondary: string;
  divider: string;
  error: string;
  warning: string;
  success: string;
}

export const THEMES: ThemeDefinition[] = [
  {
    id: 'light',
    name: 'Light',
    mode: 'light',
    primary: '#2563eb',
    secondary: '#7c3aed',
    backdrop: '#e6e8ec',
    surface: '#ffffff',
    text: '#1f2328',
    textSecondary: '#59636e',
    divider: '#d8dce2',
    error: '#d32f2f',
    warning: '#b45309',
    success: '#2e7d32',
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    mode: 'light',
    primary: '#af3a03',
    secondary: '#076678',
    backdrop: '#ebdbb2',
    surface: '#fbf1c7',
    text: '#3c3836',
    textSecondary: '#7c6f64',
    divider: '#d5c4a1',
    error: '#9d0006',
    warning: '#b57614',
    success: '#79740e',
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    mode: 'light',
    primary: '#268bd2',
    secondary: '#2aa198',
    backdrop: '#eee8d5',
    surface: '#fdf6e3',
    text: '#586e75',
    textSecondary: '#839496',
    divider: '#e4dcc4',
    error: '#dc322f',
    warning: '#b58900',
    success: '#859900',
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    mode: 'light',
    primary: '#8839ef',
    secondary: '#1e66f5',
    backdrop: '#dce0e8',
    surface: '#eff1f5',
    text: '#4c4f69',
    textSecondary: '#6c6f85',
    divider: '#ccd0da',
    error: '#d20f39',
    warning: '#df8e1d',
    success: '#40a02b',
  },
  {
    id: 'dark',
    name: 'Dark',
    mode: 'dark',
    primary: '#6ea0ff',
    secondary: '#b39ddb',
    backdrop: '#1b1c1f',
    surface: '#26282c',
    text: '#e8eaed',
    textSecondary: '#a0a4ab',
    divider: '#3a3d42',
    error: '#f28b82',
    warning: '#fdd663',
    success: '#81c995',
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    mode: 'dark',
    primary: '#fe8019',
    secondary: '#83a598',
    backdrop: '#1d2021',
    surface: '#282828',
    text: '#ebdbb2',
    textSecondary: '#a89984',
    divider: '#504945',
    error: '#fb4934',
    warning: '#fabd2f',
    success: '#b8bb26',
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    mode: 'dark',
    primary: '#268bd2',
    secondary: '#2aa198',
    backdrop: '#00212b',
    surface: '#002b36',
    text: '#93a1a1',
    textSecondary: '#839496',
    divider: '#073642',
    error: '#dc322f',
    warning: '#b58900',
    success: '#859900',
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    mode: 'dark',
    primary: '#cba6f7',
    secondary: '#89b4fa',
    backdrop: '#11111b',
    surface: '#1e1e2e',
    text: '#cdd6f4',
    textSecondary: '#a6adc8',
    divider: '#313244',
    error: '#f38ba8',
    warning: '#f9e2af',
    success: '#a6e3a1',
  },
  {
    id: 'nord',
    name: 'Nord',
    mode: 'dark',
    primary: '#88c0d0',
    secondary: '#81a1c1',
    backdrop: '#242933',
    surface: '#2e3440',
    text: '#eceff4',
    textSecondary: '#aeb7c6',
    divider: '#3b4252',
    error: '#bf616a',
    warning: '#ebcb8b',
    success: '#a3be8c',
  },
  {
    id: 'dracula',
    name: 'Dracula',
    mode: 'dark',
    primary: '#bd93f9',
    secondary: '#ff79c6',
    backdrop: '#1e1f29',
    surface: '#282a36',
    text: '#f8f8f2',
    textSecondary: '#b5b9d4',
    divider: '#44475a',
    error: '#ff5555',
    warning: '#f1fa8c',
    success: '#50fa7b',
  },
];

export const DEFAULT_LIGHT = THEMES.find((t) => t.id === 'light')!;
export const DEFAULT_DARK = THEMES.find((t) => t.id === 'dark')!;

const cache = new Map<string, Theme>();

export function buildTheme(def: ThemeDefinition): Theme {
  const cached = cache.get(def.id);
  if (cached) return cached;
  const theme = createTheme({
    palette: {
      mode: def.mode,
      primary: { main: def.primary },
      secondary: { main: def.secondary },
      error: { main: def.error },
      warning: { main: def.warning },
      success: { main: def.success },
      background: { default: def.backdrop, paper: def.surface },
      text: { primary: def.text, secondary: def.textSecondary },
      divider: def.divider,
      action: {
        hover: alpha(def.text, 0.07),
        selected: alpha(def.primary, def.mode === 'dark' ? 0.24 : 0.14),
      },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      button: { textTransform: 'none', fontWeight: 500 },
    },
    components: {
      MuiTooltip: { defaultProps: { enterDelay: 500, arrow: true } },
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiToggleButton: { styleOverrides: { root: { paddingTop: 4, paddingBottom: 4 } } },
      // Dark-mode MUI tints raised surfaces; keep the theme's own surface colour.
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiAppBar: { styleOverrides: { root: { backgroundColor: def.surface, color: def.text } } },
    },
  });
  cache.set(def.id, theme);
  return theme;
}
