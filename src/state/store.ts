import type { PDFDocument } from 'pdf-lib';
import { create } from 'zustand';
import type { PageInfo } from '../lib/geometry';
import { loadPdf, type LoadedPdf, type PDFDocumentProxy } from '../lib/pdfjs';
import {
  DEFAULT_LINE_HEIGHT,
  type OriginalAnnotation,
  type TextObject,
  type TextStyle,
} from '../model/types';
import { fontProvider, naturalTextWidth } from '../lib/fonts';
import { findInstalledMatch, resolveInstalledFont } from '../lib/installedFonts';
import { standardFontFor, type SourceFontInfo } from '../pdf/fontMatch';
import {
  convertItem,
  exportDocument,
  objectChanged,
  hideAnnotations,
  loadEditable,
  openDocument,
  EncryptedDocumentError,
} from '../pdf/session';
import type { TextItemGeometry } from '../pdf/textEdit';
import { basename, downloadPdf, inTauri, pickSavePath, writePdf, type OpenedFile } from '../platform/files';

/** select: highlight and copy text only · edit: change and move text · text: add new text */
export type Tool = 'select' | 'edit' | 'text';

/**
 * Existing page text that was clicked for editing. Until it is actually
 * changed this isn't an edit: clicking elsewhere puts the original back, and
 * nothing is recorded for undo.
 */
export interface PendingConversion {
  objectId: string;
  pageIndex: number;
  /** The document before the text was clicked. */
  base: Snapshot;
  /** The editable object as first created, to tell whether it has changed. */
  initial: TextObject;
}

/** Everything undo/redo restores. Snapshots are immutable. */
export interface Snapshot {
  /** The PDF shown in the viewer (edited page text removed, edited annotations hidden). */
  workingBytes: Uint8Array;
  objects: TextObject[];
  /** Existing annotations hidden in `workingBytes` because we draw them ourselves. */
  hiddenKeys: string[];
  /** Bumped whenever page content changes (used for "unsaved changes"). */
  revision: number;
}

export interface DocInfo {
  name: string;
  path: string | null;
  editable: boolean;
  originals: OriginalAnnotation[];
  pages: PageInfo[];
}

export interface Notice {
  id: number;
  severity: 'success' | 'info' | 'warning' | 'error';
  message: string;
}

interface EditorState {
  doc: DocInfo | null;
  pendingConversion: PendingConversion | null;
  pdf: PDFDocumentProxy | null;
  pageVersions: number[];
  current: Snapshot | null;
  saved: Snapshot | null;
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  selectedId: string | null;
  editingId: string | null;
  /** Annotation keys being hidden right now (overlay shown before the canvas updates). */
  activatingKeys: string[];
  tool: Tool;
  zoom: number;
  fitWidth: boolean;
  defaultStyle: TextStyle;
  busy: string | null;
  notice: Notice | null;
  currentPage: number;
  pageJump: { index: number; nonce: number } | null;
  caretHint: { id: string; clientX: number; clientY: number } | null;
}

const DEFAULT_STYLE: TextStyle = { family: 'Helvetica', bold: false, italic: false, size: 12, color: [0, 0, 0] };

export const useEditor = create<EditorState>(() => ({
  doc: null,
  pendingConversion: null,
  pdf: null,
  pageVersions: [],
  current: null,
  saved: null,
  undoStack: [],
  redoStack: [],
  selectedId: null,
  editingId: null,
  activatingKeys: [],
  tool: 'select',
  zoom: 1,
  fitWidth: true,
  defaultStyle: DEFAULT_STYLE,
  busy: null,
  notice: null,
  currentPage: 0,
  pageJump: null,
  caretHint: null,
}));

const get = useEditor.getState;
const set = useEditor.setState;

// ---------------------------------------------------------------------------
// Internals: pdf-lib document cache, pdf.js reloads, history
// ---------------------------------------------------------------------------

let idCounter = 0;
export function newId(): string {
  return `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The pdf-lib document matching `bytes` (reloaded after undo/redo). */
let lib: { bytes: Uint8Array; doc: PDFDocument } | null = null;
async function libDocFor(bytes: Uint8Array): Promise<PDFDocument> {
  if (lib?.bytes === bytes) return lib.doc;
  const doc = await loadEditable(bytes);
  lib = { bytes, doc };
  return doc;
}

let loaded: LoadedPdf | null = null;
let loadSequence = 0;

/** Reloads the viewer from new working bytes and re-renders the given pages. */
async function showBytes(bytes: Uint8Array, changedPages: number[] | 'all'): Promise<void> {
  const seq = ++loadSequence;
  const next = await loadPdf(bytes);
  if (seq !== loadSequence) {
    void next.task.destroy();
    return;
  }
  const previous = loaded;
  loaded = next;
  set((s) => ({
    pdf: next.pdf,
    pageVersions: s.pageVersions.map((v, i) => (changedPages === 'all' || changedPages.includes(i) ? v + 1 : v)),
  }));
  // Let pages switch to the new document before tearing down the old one.
  setTimeout(() => void previous?.task.destroy(), 1000);
}

let gestureBase: Snapshot | null = null;

const HISTORY_STEPS = 200;
/** Edits of page text keep a copy of the PDF per step; cap the memory that can hold. */
const HISTORY_BYTES = 300 * 1024 * 1024;

function trimHistory(stack: Snapshot[]): Snapshot[] {
  let trimmed = stack.slice(-HISTORY_STEPS);
  for (;;) {
    const seen = new Set<Uint8Array>();
    let total = 0;
    for (const snap of trimmed) {
      if (seen.has(snap.workingBytes)) continue;
      seen.add(snap.workingBytes);
      total += snap.workingBytes.byteLength;
    }
    if (total <= HISTORY_BYTES || trimmed.length <= 1) return trimmed;
    trimmed = trimmed.slice(1);
  }
}

/** Same objects by value: identical, or equal copies of the same objects. */
function sameObjects(a: TextObject[], b: TextObject[]): boolean {
  return (
    a === b ||
    (a.length === b.length && a.every((o, i) => o === b[i] || (o.id === b[i].id && !objectChanged(o, b[i]))))
  );
}

/**
 * Records an undo step. While a click-to-edit conversion is pending, the
 * snapshot from before the click is recorded instead: the conversion and the
 * first real change are one step, and undoing it brings the original back.
 */
function pushUndo(snapshot: Snapshot): void {
  const { pendingConversion, undoStack } = get();
  set({
    undoStack: trimHistory([...undoStack, pendingConversion?.base ?? snapshot]),
    redoStack: [],
    pendingConversion: null,
  });
}

function apply(next: Snapshot): void {
  const { current } = get();
  if (!current) return;
  if (!gestureBase) pushUndo(current);
  set({ current: next });
}

function pendingChanged(current: Snapshot | null, p: PendingConversion): boolean {
  const obj = current?.objects.find((o) => o.id === p.objectId);
  return !obj || objectChanged(obj, p.initial) || current!.objects.length !== p.base.objects.length + 1;
}

/**
 * Ends a pending click-to-edit: if the text wasn't changed, the original is
 * put back exactly as it was, with nothing recorded for undo.
 */
export function settlePending(): void {
  const { pendingConversion: p, current } = get();
  if (!p || !current || gestureBase) return;
  if (pendingChanged(current, p)) {
    pushUndo(current); // changed after all: keep it as one step
    return;
  }
  set((s) => ({
    current: p.base,
    pendingConversion: null,
    selectedId: s.selectedId === p.objectId ? null : s.selectedId,
    editingId: s.editingId === p.objectId ? null : s.editingId,
  }));
  void showBytes(p.base.workingBytes, [p.pageIndex]);
}

/** Groups the changes of a drag or a typing session into one undo step. */
export function beginGesture(): void {
  if (!gestureBase) gestureBase = get().current;
}

export function endGesture(): void {
  const base = gestureBase;
  gestureBase = null;
  const { current } = get();
  if (!base || !current) return;
  if (!sameObjects(base.objects, current.objects) || base.revision !== current.revision) {
    pushUndo(base);
  } else if (base.objects !== current.objects) {
    // Changed and changed back (e.g. typed, then deleted it): nothing happened.
    set({ current: { ...current, objects: base.objects } });
  }
}

function notify(severity: Notice['severity'], message: string): void {
  set({ notice: { id: Date.now(), severity, message } });
}

export function dismissNotice(): void {
  set({ notice: null });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function isDirty(s: Pick<EditorState, 'current' | 'saved' | 'pendingConversion'> = get()): boolean {
  // Text that was only clicked, not changed, doesn't count.
  const p = s.pendingConversion;
  const current = p && !pendingChanged(s.current, p) ? p.base : s.current;
  return (
    !!current && !!s.saved && (!sameObjects(current.objects, s.saved.objects) || current.revision !== s.saved.revision)
  );
}

export async function openFile(file: OpenedFile): Promise<void> {
  set({ busy: 'Opening…' });
  try {
    let readOnlyReason: string | null = null;
    let opened: Awaited<ReturnType<typeof openDocument>> | null = null;
    try {
      opened = await openDocument(file.bytes, newId);
    } catch (e) {
      readOnlyReason =
        e instanceof EncryptedDocumentError ? e.message : `This PDF can be viewed but not edited (${errorMessage(e)}).`;
    }
    const workingBytes = opened?.workingBytes ?? file.bytes;
    let next: LoadedPdf;
    try {
      next = await loadPdf(workingBytes);
    } catch (e) {
      throw new Error(`“${file.name}” could not be opened: ${errorMessage(e)}`);
    }

    const pages: PageInfo[] = [];
    for (let i = 1; i <= next.pdf.numPages; i++) {
      const page = await next.pdf.getPage(i);
      pages.push({ view: [...page.view] as PageInfo['view'], rotation: page.rotate });
    }

    const objects = opened ? await resolveAnnotationFonts(opened.originals, opened.objects) : [];

    loadSequence++;
    const previous = loaded;
    loaded = next;
    lib = opened ? { bytes: workingBytes, doc: opened.doc } : null;
    gestureBase = null;
    const snapshot: Snapshot = {
      workingBytes,
      objects,
      hiddenKeys: opened?.hiddenKeys ?? [],
      revision: 0,
    };
    set((s) => ({
      doc: { name: file.name, path: file.path, editable: !!opened, originals: opened?.originals ?? [], pages },
      pendingConversion: null,
      pdf: next.pdf,
      pageVersions: pages.map(() => 0),
      current: snapshot,
      saved: snapshot,
      undoStack: [],
      redoStack: [],
      selectedId: null,
      editingId: null,
      activatingKeys: [],
      tool: 'select',
      fitWidth: true,
      currentPage: 0,
      pageJump: { index: 0, nonce: (s.pageJump?.nonce ?? 0) + 1 },
    }));
    void previous?.task.destroy();
    if (readOnlyReason) notify('warning', readOnlyReason);
  } catch (e) {
    notify('error', errorMessage(e));
  } finally {
    set({ busy: null });
  }
}

export type SaveMode = 'save' | 'saveAs' | 'flattenedCopy';

export async function save(mode: SaveMode = 'save'): Promise<boolean> {
  stopEditing();
  settlePending();
  const { doc, current } = get();
  if (!doc || !current || !doc.editable) return false;

  const suffix = mode === 'flattenedCopy' ? ' (flattened)' : '';
  const suggested = doc.name.replace(/\.pdf$/i, '') + suffix + '.pdf';
  let path = mode === 'save' ? doc.path : null;
  if (inTauri && !path) {
    path = await pickSavePath(suggested, doc.path);
    if (!path) return false;
  }

  set({ busy: 'Saving…' });
  try {
    const bytes = await exportDocument(
      current.workingBytes,
      current.objects,
      doc.originals,
      current.hiddenKeys,
      { flatten: mode === 'flattenedCopy' },
      fontProvider,
    );
    const name = path ? basename(path) : suggested;
    if (inTauri && path) await writePdf(path, bytes);
    else downloadPdf(bytes, mode === 'save' ? doc.name : suggested);

    if (mode !== 'flattenedCopy') {
      set((s) => ({ saved: s.current === current ? current : s.saved, doc: s.doc && { ...s.doc, path, name } }));
    }
    notify('success', inTauri ? `Saved “${name}”` : `Downloaded “${name}”`);
    return true;
  } catch (e) {
    notify('error', `Saving failed: ${errorMessage(e)}`);
    return false;
  } finally {
    set({ busy: null });
  }
}

// ---------------------------------------------------------------------------
// Text objects
// ---------------------------------------------------------------------------

export function objectById(id: string | null): TextObject | undefined {
  return id ? get().current?.objects.find((o) => o.id === id) : undefined;
}

export function updateObject(id: string, patch: Partial<TextObject>): void {
  const { current } = get();
  const obj = objectById(id);
  if (!current || !obj) return;
  if (obj.annotKey) void revealAnnotation(obj);
  // A style in the patch replaces the old one (callers pass complete styles).
  const updated: TextObject = { ...obj, ...patch, style: patch.style ?? obj.style };
  // Setting what's already there isn't a change (and mustn't become an undo step).
  if (!objectChanged(updated, obj) && updated.fit === obj.fit && updated.sourceFont === obj.sourceFont) return;
  apply({ ...current, objects: current.objects.map((o) => (o.id === id ? updated : o)) });
}

/**
 * Applies a style change. Choosing a standard family drops any installed
 * font; changing weight, slant or font forgets an exact matched face (e.g.
 * "Helvetica-Light"), so the face is picked again from the family.
 */
export function withStyle(style: TextStyle, patch: Partial<TextStyle>): TextStyle {
  const next: TextStyle = { ...style, ...patch };
  if ('family' in patch && !('font' in patch)) delete next.font;
  if (next.font?.face && !patch.font?.face && ('bold' in patch || 'italic' in patch || 'font' in patch)) {
    next.font = { family: next.font.family };
  }
  if (!next.font) delete next.font;
  return next;
}

/** Point size at which `style` takes the same width as the original text it replaces. */
async function fittedSize(style: TextStyle, fit: NonNullable<TextObject['fit']>): Promise<number> {
  const natural = await naturalTextWidth({ ...style, size: fit.size }, fit.text);
  if (!(natural > 0) || !(fit.width > 0)) return fit.size;
  // Bounded, so an odd measurement can't produce absurd sizes.
  const ratio = Math.min(1.3, Math.max(0.7, fit.width / natural));
  return Math.round(fit.size * ratio * 10) / 10;
}

export function updateStyle(patch: Partial<TextStyle>): void {
  const { selectedId } = get();
  const obj = objectById(selectedId);
  set((s) => ({ defaultStyle: withStyle(s.defaultStyle, patch) }));
  if (!obj) return;
  const fontChanged = 'family' in patch || 'font' in patch;
  const style = withStyle(obj.style, patch);
  const change: Partial<TextObject> = {
    style,
    sourceFont: fontChanged ? undefined : obj.sourceFont,
    // Choosing a size yourself ends automatic sizing.
    fit: 'size' in patch ? undefined : obj.fit,
  };
  const refit = obj.fit && !('size' in patch) && (fontChanged || 'bold' in patch || 'italic' in patch);
  if (!refit) {
    updateObject(obj.id, change);
    return;
  }
  // Text in a substitute font keeps the original's width when the font changes.
  void fittedSize(style, obj.fit!).then((size) => {
    if (objectById(obj.id)) updateObject(obj.id, { ...change, style: { ...style, size } });
  });
}

/** Fonts we've already told the user are missing (once per session each). */
const reportedMissingFonts = new Set<string>();

function fontLabel(style: TextStyle): string {
  return style.font?.family ?? style.family;
}

/**
 * Uses the original font of existing text when it's available (a standard
 * PDF font, or the same font installed on this computer). Otherwise keeps the
 * original size, weight, slant and colour but uses the font the user has
 * chosen in the font list.
 */
async function matchOriginalFont(style: TextStyle, source: SourceFontInfo): Promise<{ style: TextStyle; matched: boolean }> {
  const standard = standardFontFor(source.postscriptName);
  if (standard) return { style: { ...withStyle(style, { family: standard.family }), ...standard }, matched: true };
  const match = await findInstalledMatch(source);
  if (match) return { style: { ...style, font: match.ref, bold: match.bold, italic: match.italic }, matched: true };
  const { defaultStyle } = get();
  const chosen: TextStyle = { ...style, family: defaultStyle.family };
  if (defaultStyle.font) chosen.font = { family: defaultStyle.font.family };
  else delete chosen.font;
  return { style: chosen, matched: false };
}

function reportMissingFont(name: string, used: TextStyle): void {
  const display = name.replace(/[-,].*$/, '').replace(/(PSMT|MT)$/, '') || name;
  if (reportedMissingFonts.has(display)) return;
  reportedMissingFonts.add(display);
  notify(
    'info',
    `The original font “${display}” isn’t installed, so ${fontLabel(used)} is used instead. You can choose another font in the font list.`,
  );
}

/** Resolves the installed fonts named by annotations in the file (same result for the original copy). */
async function resolveAnnotationFonts(originals: OriginalAnnotation[], objects: TextObject[]): Promise<TextObject[]> {
  const byKey = new Map<string, TextStyle>();
  for (const original of originals) {
    const { style } = original.object;
    if (!style.font) continue;
    const found = await resolveInstalledFont(style.font, style.bold, style.italic);
    const name = style.font.face ?? style.font.family;
    let next: TextStyle = style;
    if (!found) {
      const { defaultStyle } = get();
      next = { ...style, family: defaultStyle.family };
      if (defaultStyle.font) next.font = { family: defaultStyle.font.family };
      else delete next.font;
    }
    original.object = { ...original.object, style: next, sourceFont: { name, matched: !!found } };
    byKey.set(original.key, next);
  }
  return objects.map((o) => {
    const style = o.annotKey ? byKey.get(o.annotKey) : undefined;
    if (!style) return o;
    const original = originals.find((x) => x.key === o.annotKey)!;
    return { ...o, style, sourceFont: original.object.sourceFont };
  });
}

export function addText(pageIndex: number, x: number, y: number, angle: number): void {
  settlePending();
  const { current, defaultStyle, doc } = get();
  if (!current || !doc?.editable) return;
  const obj: TextObject = {
    id: newId(),
    pageIndex,
    kind: 'annotation',
    text: '',
    x,
    y,
    angle,
    style: { ...defaultStyle },
    lineHeight: DEFAULT_LINE_HEIGHT,
    wrapWidth: null,
    background: null,
  };
  beginGesture();
  set({ current: { ...current, objects: [...current.objects, obj] }, selectedId: obj.id, editingId: obj.id, tool: 'edit' });
}

export function deleteObject(id: string): void {
  const { current } = get();
  if (!current) return;
  apply({ ...current, objects: current.objects.filter((o) => o.id !== id) });
  set((s) => ({
    selectedId: s.selectedId === id ? null : s.selectedId,
    editingId: s.editingId === id ? null : s.editingId,
  }));
}

export function select(id: string | null): void {
  const { editingId, pendingConversion } = get();
  if (editingId && editingId !== id) stopEditing();
  if (pendingConversion && pendingConversion.objectId !== id) settlePending();
  set({ selectedId: id });
}

export function startEditing(id: string, caret?: { clientX: number; clientY: number }): void {
  const obj = objectById(id);
  if (!obj) return;
  if (get().editingId && get().editingId !== id) stopEditing();
  if (obj.annotKey) void revealAnnotation(obj);
  beginGesture();
  set({ selectedId: id, editingId: id, caretHint: caret ? { id, ...caret } : null });
}

export function stopEditing(): void {
  const { editingId, current } = get();
  if (!editingId || !current) return;
  const obj = objectById(editingId);
  set({ editingId: null, caretHint: null });
  if (obj && obj.text.trim() === '') {
    // Emptied text is removed (for edited page text, the original stays deleted).
    set({ current: { ...current, objects: current.objects.filter((o) => o.id !== obj.id) }, selectedId: null });
  }
  endGesture();
}

/**
 * Hides an existing annotation's own appearance in the viewer so our editable
 * overlay can take its place. Not an undoable step on its own.
 */
async function revealAnnotation(obj: TextObject): Promise<void> {
  const key = obj.annotKey!;
  const { current, activatingKeys } = get();
  if (!current || current.hiddenKeys.includes(key) || activatingKeys.includes(key)) return;
  set({ activatingKeys: [...activatingKeys, key] });
  try {
    const base = get().current!;
    const doc = await libDocFor(base.workingBytes);
    const bytes = await hideAnnotations(doc, [key]);
    lib = { bytes, doc };
    const latest = get().current!;
    if (latest.workingBytes === base.workingBytes) {
      set({ current: { ...latest, workingBytes: bytes, hiddenKeys: [...latest.hiddenKeys, key] } });
      await showBytes(bytes, [obj.pageIndex]);
    }
  } catch (e) {
    lib = null;
    notify('error', `Could not edit this annotation: ${errorMessage(e)}`);
  } finally {
    set((s) => ({ activatingKeys: s.activatingKeys.filter((k) => k !== key) }));
  }
}

/** Turns a line of existing page text into an editable text object. */
export async function editExistingText(
  pageIndex: number,
  item: TextItemGeometry,
  caret?: { clientX: number; clientY: number },
): Promise<void> {
  const { current, doc, busy } = get();
  if (!current || !doc?.editable || busy) return;
  stopEditing();
  settlePending();
  set({ busy: 'Preparing text for editing…' });
  try {
    const base = get().current!;
    const pdfDoc = await libDocFor(base.workingBytes);
    const converted = await convertItem(pdfDoc, pageIndex, item, newId());
    if (!converted) {
      notify('info', 'This text can’t be edited here — it may be part of an image or drawn as shapes.');
      return;
    }
    lib = { bytes: converted.bytes, doc: pdfDoc };
    const { invisibleText, sourceFont, extent } = converted.result;
    const font = await matchOriginalFont(converted.result.object.style, sourceFont);
    let object: TextObject = {
      ...converted.result.object,
      style: font.style,
      sourceFont: { name: sourceFont.postscriptName, matched: font.matched },
    };
    if (!font.matched) {
      // A substitute font has different proportions (Helvetica is much wider than
      // Calibri at the same point size), so size it to take the original's width.
      const hScale = object.hScale ?? 1;
      const spacing = (object.charSpacing ?? 0) * Math.max(0, [...object.text].length - 1);
      const fit = { text: object.text, width: (extent - spacing) / hScale, size: object.style.size };
      object = { ...object, fit, style: { ...object.style, size: await fittedSize(object.style, fit) } };
    }
    if (!font.matched) reportMissingFont(sourceFont.postscriptName, font.style);
    await showBytes(converted.bytes, [pageIndex]);
    // Not an undo step yet: only becomes one if the text is actually changed.
    const before = get().current!;
    set({
      current: { ...before, workingBytes: converted.bytes, objects: [...before.objects, object], revision: base.revision + 1 },
      pendingConversion: { objectId: object.id, pageIndex, base: before, initial: object },
    });
    startEditing(object.id, caret);
    if (invisibleText) {
      notify('info', 'This text is part of a scanned image, so a white background was added to cover the original.');
    }
  } catch (e) {
    lib = null;
    notify('error', `Could not edit this text: ${errorMessage(e)}`);
  } finally {
    set({ busy: null });
  }
}

// ---------------------------------------------------------------------------
// Undo / redo, tools, view
// ---------------------------------------------------------------------------

function restore(next: Snapshot, from: 'undo' | 'redo'): void {
  const { current, undoStack, redoStack, selectedId } = get();
  if (!current) return;
  const stacks =
    from === 'undo'
      ? { undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, current] }
      : { undoStack: trimHistory([...undoStack, current]), redoStack: redoStack.slice(0, -1) };
  set({
    ...stacks,
    current: next,
    selectedId: next.objects.some((o) => o.id === selectedId) ? selectedId : null,
  });
  if (next.workingBytes !== current.workingBytes) void showBytes(next.workingBytes, 'all');
}

export function undo(): void {
  stopEditing();
  settlePending();
  const { undoStack, busy } = get();
  if (busy || !undoStack.length) return;
  restore(undoStack[undoStack.length - 1], 'undo');
}

export function redo(): void {
  stopEditing();
  settlePending();
  const { redoStack, busy } = get();
  if (busy || !redoStack.length) return;
  restore(redoStack[redoStack.length - 1], 'redo');
}

export function setTool(tool: Tool): void {
  stopEditing();
  settlePending();
  set({ tool, selectedId: tool === 'edit' ? get().selectedId : null });
  if (tool !== 'select') window.getSelection()?.removeAllRanges();
}

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function setZoom(zoom: number): void {
  set({ zoom: Math.min(4, Math.max(0.25, zoom)), fitWidth: false });
}

export function zoomStep(direction: 1 | -1): void {
  const { zoom } = get();
  const next =
    direction > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) ?? 4 : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001) ?? 0.25;
  setZoom(next);
}

export function fitWidth(): void {
  set({ fitWidth: true });
}

export function jumpToPage(index: number): void {
  const { doc, pageJump } = get();
  if (!doc) return;
  const clamped = Math.min(doc.pages.length - 1, Math.max(0, index));
  set({ pageJump: { index: clamped, nonce: (pageJump?.nonce ?? 0) + 1 } });
}

export function setCurrentPage(index: number): void {
  if (get().currentPage !== index) set({ currentPage: index });
}

export function showNotice(severity: Notice['severity'], message: string): void {
  notify(severity, message);
}
