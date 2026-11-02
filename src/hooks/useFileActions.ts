import { confirmDiscard, pickPdf, readPdf, type OpenedFile } from '../platform/files';
import { isDirty, openFile, showNotice, stopEditing, useEditor } from '../state/store';

const DISCARD_MESSAGE = 'You have unsaved changes. Discard them and open another file?';

async function okToReplace(): Promise<boolean> {
  stopEditing();
  return !isDirty() || confirmDiscard(DISCARD_MESSAGE);
}

/** "Open…" — asks to discard unsaved changes first. */
export async function requestOpen(): Promise<void> {
  if (useEditor.getState().busy || !(await okToReplace())) return;
  try {
    const file = await pickPdf();
    if (file) await openFile(file);
  } catch (e) {
    showNotice('error', e instanceof Error ? e.message : String(e));
  }
}

/** Opens a file from a path (drag & drop, "Open With", command line). */
export async function requestOpenPath(path: string): Promise<void> {
  if (useEditor.getState().busy || !(await okToReplace())) return;
  try {
    await openFile(await readPdf(path));
  } catch (e) {
    showNotice('error', e instanceof Error ? e.message : String(e));
  }
}

export async function requestOpenFile(file: OpenedFile): Promise<void> {
  if (useEditor.getState().busy || !(await okToReplace())) return;
  await openFile(file);
}
