import useMediaQuery from '@mui/material/useMediaQuery';
import { create } from 'zustand';
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, type ThemeDefinition } from './themes';

/** "system" follows the OS appearance (Light/Dark); otherwise a theme id. */
export type ThemeChoice = 'system' | string;

const STORAGE_KEY = 'pdf-editor.theme';

function initialChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (saved === 'system' || THEMES.some((t) => t.id === saved))) return saved;
  } catch {
    // Storage unavailable: fall back to the system appearance.
  }
  return 'system';
}

export const useThemeChoice = create<{ choice: ThemeChoice }>(() => ({ choice: initialChoice() }));

export function setThemeChoice(choice: ThemeChoice): void {
  useThemeChoice.setState({ choice });
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Not persisted; still applied for this session.
  }
}

/** The theme to show for the current choice and OS appearance. */
export function useActiveTheme(): ThemeDefinition {
  const choice = useThemeChoice((s) => s.choice);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });
  if (choice === 'system') return prefersDark ? DEFAULT_DARK : DEFAULT_LIGHT;
  return THEMES.find((t) => t.id === choice) ?? DEFAULT_LIGHT;
}
