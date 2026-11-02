export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Human-readable shortcut label, e.g. "⌘S" or "Ctrl+S". */
export function shortcut(key: string, shift = false): string {
  if (isMac) return `${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}
