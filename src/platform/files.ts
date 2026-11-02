import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * File access. In the Tauri app this uses native dialogs and Rust commands
 * (binary IPC, atomic writes). In a plain browser (`pnpm dev`) it falls back
 * to a file input and downloads, which keeps the UI easy to develop and test.
 */

export const inTauri = isTauri();

export interface OpenedFile {
  /** Absolute path on disk, or null when opened in a browser. */
  path: string | null;
  name: string;
  bytes: Uint8Array;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export async function readPdf(path: string): Promise<OpenedFile> {
  const buffer = await invoke<ArrayBuffer>('read_file', { path });
  return { path, name: basename(path), bytes: new Uint8Array(buffer) };
}

export async function pickPdf(): Promise<OpenedFile | null> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'PDF documents', extensions: ['pdf', 'PDF'] }],
    });
    return path ? readPdf(path) : null;
  }
  return pickWithInput();
}

function pickWithInput(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      resolve(file ? { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function openBrowserFile(file: File): Promise<OpenedFile> {
  return { path: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Asks where to save; returns null if cancelled. */
export async function pickSavePath(suggestedName: string, directoryOf?: string | null): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  let defaultPath = suggestedName;
  if (directoryOf) {
    const sepIndex = Math.max(directoryOf.lastIndexOf('/'), directoryOf.lastIndexOf('\\'));
    if (sepIndex >= 0) defaultPath = directoryOf.slice(0, sepIndex + 1) + suggestedName;
  }
  const path = await save({ defaultPath, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (!path) return null;
  return /\.pdf$/i.test(path) ? path : `${path}.pdf`;
}

export async function writePdf(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}

/** Browser fallback for saving: download the file. */
export function downloadPdf(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function confirmDiscard(message: string): Promise<boolean> {
  if (inTauri) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard Changes', cancelLabel: 'Cancel' });
  }
  return window.confirm(message);
}
