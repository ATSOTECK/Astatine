import { PDFDict, PDFName, PDFPage, type PDFContext } from 'pdf-lib';
import type { ContentContainer, Glyph, TextShowOp } from './interpreter';
import { formatNumber, serializeObject, spliceOperations, type CSObject } from './lexer';
import { getDict, shallowCopyDict } from './objects';

/**
 * Removes glyphs from a page's content while keeping every other glyph
 * exactly where it was. Each removed glyph is replaced by a TJ spacing
 * adjustment equal to its advance, so text that follows in the same text
 * object does not shift. Form XObjects are copied before being modified so
 * that other pages (or other uses on this page) are unaffected.
 */
export function removeGlyphsFromPage(page: PDFPage, root: ContentContainer, glyphs: Glyph[]): number {
  const context = page.node.context;
  const edits = new Map<ContentContainer, Map<number, Set<number>>>();
  let removed = 0;
  for (const g of glyphs) {
    if (g.show.fontSize === 0) continue; // cannot be expressed as a TJ adjustment
    let ops = edits.get(g.container);
    if (!ops) edits.set(g.container, (ops = new Map()));
    let set = ops.get(g.show.opIndex);
    if (!set) ops.set(g.show.opIndex, (set = new Set()));
    set.add(g.glyphIndex);
    removed++;
  }
  if (removed === 0) return 0;

  // A container must be rewritten if it, or anything nested in it, changed.
  const dirty = new Set<ContentContainer>();
  const markDirty = (c: ContentContainer): boolean => {
    let isDirty = edits.has(c);
    for (const child of c.children.values()) if (markDirty(child)) isDirty = true;
    if (isDirty) dirty.add(c);
    return isDirty;
  };
  if (!markDirty(root)) return 0;

  const result = rewriteContainer(context, root, edits, dirty);
  const contentRef = context.register(context.flateStream(result.bytes));
  page.node.set(PDFName.of('Contents'), contentRef);
  if (result.resources) page.node.set(PDFName.of('Resources'), result.resources);
  return removed;
}

function rewriteContainer(
  context: PDFContext,
  container: ContentContainer,
  edits: Map<ContentContainer, Map<number, Set<number>>>,
  dirty: Set<ContentContainer>,
): { bytes: Uint8Array; resources?: PDFDict } {
  const replacements = new Map<number, string>();
  for (const [opIndex, removed] of edits.get(container) ?? []) {
    const show = container.textOps.get(opIndex);
    if (show) replacements.set(opIndex, rewriteShowOperation(show, removed));
  }

  let resources: PDFDict | undefined;
  for (const [doIndex, child] of container.children) {
    if (!dirty.has(child) || !child.stream) continue;
    const rewritten = rewriteContainer(context, child, edits, dirty);

    const copy = context.flateStream(rewritten.bytes);
    for (const [key, value] of child.stream.dict.entries()) {
      const k = key.decodeText();
      if (k === 'Length' || k === 'Filter' || k === 'DecodeParms' || k === 'DL') continue;
      copy.dict.set(key, value);
    }
    if (rewritten.resources) copy.dict.set(PDFName.of('Resources'), rewritten.resources);
    const ref = context.register(copy);

    if (!resources) {
      resources = shallowCopyDict(container.resources, context);
      resources.set(PDFName.of('XObject'), shallowCopyDict(getDict(container.resources, 'XObject'), context));
    }
    const xobjects = resources.get(PDFName.of('XObject')) as PDFDict;
    let i = 1;
    while (xobjects.has(PDFName.of(`PEd${i}`))) i++;
    const name = `PEd${i}`;
    xobjects.set(PDFName.of(name), ref);
    replacements.set(doIndex, `/${name} Do`);
  }

  return { bytes: spliceOperations(container.bytes, container.ops, replacements), resources };
}

/** Re-serialises a text-showing operation with some of its glyphs removed. */
export function rewriteShowOperation(show: TextShowOp, removed: Set<number>): string {
  const items: CSObject[] = [];
  const pushBytes = (bytes: Uint8Array) => {
    const last = items[items.length - 1];
    if (last?.type === 'string') {
      const merged = new Uint8Array(last.bytes.length + bytes.length);
      merged.set(last.bytes);
      merged.set(bytes, last.bytes.length);
      items[items.length - 1] = { type: 'string', bytes: merged };
    } else {
      items.push({ type: 'string', bytes });
    }
  };
  const pushAdjust = (value: number) => {
    const last = items[items.length - 1];
    if (last?.type === 'number') items[items.length - 1] = { type: 'number', value: last.value + value };
    else items.push({ type: 'number', value });
  };

  const { fontSize, charSpacing, wordSpacing } = show;
  let glyphIndex = 0;
  for (const el of show.elements) {
    if (el.kind === 'adjust') {
      pushAdjust(el.value);
      continue;
    }
    if (removed.has(glyphIndex)) {
      // Displacement of a glyph: (w0·Tfs + Tc + Tw)·Th; of a TJ number n: −n/1000·Tfs·Th.
      const extra = charSpacing + (el.wordSpace ? wordSpacing : 0);
      pushAdjust(-(el.width * 1000 + (extra * 1000) / fontSize));
    } else {
      pushBytes(el.bytes);
    }
    glyphIndex++;
  }

  // Drop no-op adjustments so the output stays tidy.
  const cleaned = items.filter((it) => !(it.type === 'number' && Math.abs(it.value) < 1e-6));
  const array = (list: CSObject[]) => `[${list.map(serializeObject).join(' ')}] TJ`;
  let tj: string;
  if (cleaned[0]?.type === 'number' && charSpacing !== 0) {
    // Character spacing never applies to TJ numbers, but some text extractors
    // (including pdf.js) add it to a leading number. Emitting that number with
    // Tc = 0 is identical per the spec and keeps those extractors accurate.
    const [lead, ...rest] = cleaned;
    tj = `0 Tc ${array([lead])} ${formatNumber(charSpacing)} Tc`;
    if (rest.length) tj += ` ${array(rest)}`;
  } else {
    tj = array(cleaned);
  }
  switch (show.op) {
    case "'":
      return `T* ${tj}`;
    case '"': {
      const [aw, ac] = show.operands;
      const tw = aw?.type === 'number' ? formatNumber(aw.value) : '0';
      const tc = ac?.type === 'number' ? formatNumber(ac.value) : '0';
      return `${tw} Tw ${tc} Tc T* ${tj}`;
    }
    default:
      return tj;
  }
}
