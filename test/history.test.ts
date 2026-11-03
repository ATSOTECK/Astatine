import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fixture, openWithPdfjs, pageText, textItems } from './helpers';

// The viewer's pdf.js loader is browser-only; load with the Node build instead.
vi.mock('../src/lib/pdfjs', () => ({
  async loadPdf(bytes: Uint8Array) {
    const task = openWithPdfjs(bytes);
    return { task, pdf: await task.promise };
  },
}));

const store = await import('../src/state/store');
const { addText, deleteObject, editExistingText, openFile, redo, stopEditing, undo, updateObject, useEditor } = store;

const state = () => useEditor.getState();
const texts = () => state().current!.objects.map((o) => o.text);
const shownText = () => pageText(state().current!.workingBytes);

/** What the formatting bar's bin button does: deletes the selected box, even mid-typing. */
const clickBin = () => deleteObject(state().selectedId!);

/** Adds a box on the first page and types into it, as in Add Text mode. */
function addAndType(text: string): string {
  addText(0, 100, 100, 0);
  const id = state().editingId!;
  updateObject(id, { text });
  return id;
}

/** Clicks the line of existing page text starting with `prefix`, as in Edit mode. */
async function clickExisting(prefix: string): Promise<string> {
  const item = (await textItems(state().current!.workingBytes)).find((i) => i.str.startsWith(prefix))!;
  await editExistingText(0, item);
  return state().editingId!;
}

beforeEach(async () => {
  await openFile({ path: null, name: 'test.pdf', bytes: fixture('pdflib.pdf') });
});

describe('undo and redo', () => {
  type Deletion = 'bin while typing' | 'Delete key';
  /** Deletes the box being typed in: with the bin, or by finishing and pressing Delete. */
  const remove = (how: Deletion) => {
    if (how === 'Delete key') stopEditing();
    deleteObject(state().selectedId!);
  };

  test.each<[Deletion, Deletion]>([
    ['bin while typing', 'bin while typing'],
    ['Delete key', 'bin while typing'],
    ['bin while typing', 'Delete key'],
    ['Delete key', 'Delete key'],
  ])('add text, delete it (%s), delete existing text (%s): each deletion is its own step', async (first, second) => {
    expect(await shownText()).toContain('Hello');
    addAndType('Note');
    remove(first);
    await clickExisting('Hello');
    remove(second);
    expect(texts()).toEqual([]);
    expect(await shownText()).not.toContain('Hello');

    undo(); // brings back only the existing text
    expect(texts()).toEqual([]);
    expect(await shownText()).toContain('Hello');

    undo(); // the added text, as typed
    expect(texts()).toEqual(['Note']);
    expect(await shownText()).toContain('Hello');

    undo(); // before it was added
    expect(texts()).toEqual([]);
    expect(state().undoStack).toHaveLength(0);

    redo();
    expect(texts()).toEqual(['Note']);
    redo();
    expect(texts()).toEqual([]);
    expect(await shownText()).toContain('Hello');
    redo();
    expect(texts()).toEqual([]);
    expect(await shownText()).not.toContain('Hello');
    expect(state().redoStack).toHaveLength(0);
  });

  test('editing existing text is one step', async () => {
    const id = await clickExisting('Hello');
    updateObject(id, { text: 'Goodbye' });
    updateObject(id, { text: 'Goodbye, world' });
    stopEditing();
    expect(state().undoStack).toHaveLength(1);

    undo();
    expect(texts()).toEqual([]);
    expect(await shownText()).toContain('Hello');
    redo();
    expect(texts()).toEqual(['Goodbye, world']);
    expect(await shownText()).not.toContain('Hello');
  });

  test('clicking text without changing it, or deleting an empty new box, is not a step', async () => {
    await clickExisting('Hello');
    stopEditing();
    store.select(null);
    expect(state().undoStack).toHaveLength(0);
    expect(await shownText()).toContain('Hello');

    addText(0, 100, 100, 0);
    clickBin();
    expect(state().undoStack).toHaveLength(0);
    expect(texts()).toEqual([]);
  });

  test('undo while still typing undoes the typing, and redo brings it back', async () => {
    addAndType('Note');
    undo(); // the toolbar button, clicked mid-typing
    expect(texts()).toEqual([]);
    redo();
    expect(texts()).toEqual(['Note']);

    const id = await clickExisting('Hello');
    updateObject(id, { text: 'Goodbye' });
    undo();
    expect(texts()).toEqual(['Note']);
    expect(await shownText()).toContain('Hello');
    redo();
    expect(texts()).toEqual(['Note', 'Goodbye']);
    expect(await shownText()).not.toContain('Hello');
  });

  test('clearing all of an existing line deletes it in one step', async () => {
    const id = await clickExisting('Hello');
    updateObject(id, { text: '' });
    stopEditing();
    expect(texts()).toEqual([]);
    expect(await shownText()).not.toContain('Hello');
    expect(state().undoStack).toHaveLength(1);

    undo();
    expect(await shownText()).toContain('Hello');
    redo();
    expect(await shownText()).not.toContain('Hello');
  });

  test('a new change after undoing clears redo', () => {
    addAndType('One');
    stopEditing();
    undo();
    expect(state().redoStack).toHaveLength(1);
    addAndType('Two');
    stopEditing();
    expect(state().redoStack).toHaveLength(0);
    redo();
    expect(texts()).toEqual(['Two']);
  });
});
