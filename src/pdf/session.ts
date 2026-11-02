import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFObject,
  PDFRef,
  PDFStream,
  StandardFonts,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setCharacterSpacing,
  setCharacterSqueeze,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { InstalledFontRef, OriginalAnnotation, TextObject } from '../model/types';
import {
  annotationByKey,
  compactAnnotations,
  deleteAnnotation,
  readFreeTextAnnotations,
  setAnnotationsHidden,
  writeFreeText,
} from './freeText';
import { boxMetrics, layoutLines, lineMeasure } from './layout';
import { isWinAnsiEncodable, standardFontName } from './standardFonts';
import { convertTextItem, type ConversionResult, type TextItemGeometry } from './textEdit';

/**
 * High-level document operations. All functions work on bytes and pdf-lib
 * documents only (no DOM), so they run the same in the app and in tests.
 */

export interface FontBytesProvider {
  /** A Unicode TrueType font (Liberation Sans) for text the standard fonts can't encode. */
  unicodeFont(bold: boolean, italic: boolean): Promise<Uint8Array>;
  /**
   * The installed font for a style that names one, as a standalone font file,
   * or null when it isn't available (the standard family is used instead).
   */
  installedFont?(ref: InstalledFontRef, bold: boolean, italic: boolean): Promise<{ key: string; bytes: Uint8Array } | null>;
}

type FontkitFont = ReturnType<typeof fontkit.create>;

/** Whether a font has a glyph for every character of the text. */
export function fontCoversText(font: Pick<FontkitFont, 'hasGlyphForCodePoint'>, text: string): boolean {
  for (const ch of normalizeText(text)) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x20) continue;
    if (!font.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
}

export class EncryptedDocumentError extends Error {}

export async function loadEditable(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message)) {
      throw new EncryptedDocumentError('This PDF is encrypted, so it can be viewed but not edited.');
    }
    throw e;
  }
}

/** Saves the in-session working copy (fast settings; unreachable objects dropped). */
export async function saveWorking(doc: PDFDocument): Promise<Uint8Array> {
  pruneUnreachableObjects(doc);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/**
 * Deletes objects no longer reachable from the trailer. pdf-lib never does
 * this, so without it the content streams we replace (with the original,
 * "deleted" text) would still be inside the saved file.
 */
export function pruneUnreachableObjects(doc: PDFDocument): void {
  const context = doc.context;
  const reachable = new Set<string>();
  const { Root, Info, Encrypt, ID } = context.trailerInfo;
  const stack: PDFObject[] = [Root, Info, Encrypt, ID].filter((o): o is PDFObject => !!o);
  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      if (reachable.has(obj.tag)) continue;
      reachable.add(obj.tag);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const v of obj.values()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) context.delete(ref);
  }
}

export interface OpenedDocument {
  /** Bytes shown in the viewer (annotations being edited are hidden). */
  workingBytes: Uint8Array;
  /** pdf-lib document matching `workingBytes`. */
  doc: PDFDocument;
  originals: OriginalAnnotation[];
  objects: TextObject[];
  /** Annotation keys hidden in the working copy because we draw them ourselves. */
  hiddenKeys: string[];
}

export async function openDocument(bytes: Uint8Array, newId: () => string): Promise<OpenedDocument> {
  const doc = await loadEditable(bytes);
  const originals = readFreeTextAnnotations(doc, newId);
  // Annotations without an appearance stream are drawn by us from the start.
  const hiddenKeys = originals.filter((o) => !o.hasAppearance).map((o) => o.key);
  let workingBytes = bytes;
  if (hiddenKeys.length) {
    setAnnotationsHidden(doc, hiddenKeys, true);
    workingBytes = await saveWorking(doc);
  }
  return {
    workingBytes,
    doc,
    originals,
    objects: originals.map((o) => structuredClone(o.object)),
    hiddenKeys,
  };
}

/** Removes an existing text item from the page and returns its replacement object. */
export async function convertItem(
  doc: PDFDocument,
  pageIndex: number,
  item: TextItemGeometry,
  id: string,
): Promise<{ result: ConversionResult; bytes: Uint8Array } | null> {
  const result = convertTextItem(doc, pageIndex, item, id);
  if (!result) return null;
  return { result, bytes: await saveWorking(doc) };
}

/** Hides annotations in the working copy so their overlay can be edited. */
export async function hideAnnotations(doc: PDFDocument, keys: string[]): Promise<Uint8Array> {
  setAnnotationsHidden(doc, keys, true);
  return saveWorking(doc);
}

const EPSILON = 1e-3;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** Whether a text object differs from how its annotation was read. */
export function objectChanged(a: TextObject, b: TextObject): boolean {
  return !(
    a.text === b.text &&
    near(a.x, b.x) &&
    near(a.y, b.y) &&
    near(a.angle, b.angle) &&
    a.style.family === b.style.family &&
    a.style.font?.family === b.style.font?.family &&
    a.style.font?.face === b.style.font?.face &&
    a.style.bold === b.style.bold &&
    a.style.italic === b.style.italic &&
    near(a.style.size, b.style.size) &&
    a.style.color.every((c, i) => near(c, b.style.color[i])) &&
    near(a.lineHeight, b.lineHeight) &&
    near(a.hScale ?? 1, b.hScale ?? 1) &&
    near(a.charSpacing ?? 0, b.charSpacing ?? 0) &&
    (a.wrapWidth === null ? b.wrapWidth === null : b.wrapWidth !== null && near(a.wrapWidth, b.wrapWidth)) &&
    (a.background === null
      ? b.background === null
      : b.background !== null && a.background.every((c, i) => near(c, b.background![i])))
  );
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

/** Whether a text object needs the embedded Unicode font instead of a standard font. */
export function needsUnicodeFont(text: string): boolean {
  return !isWinAnsiEncodable(normalizeText(text));
}

class FontCache {
  private fonts = new Map<string, Promise<PDFFont>>();
  private installed = new Map<string, Promise<{ key: string; bytes: Uint8Array; font: FontkitFont } | null>>();
  constructor(
    private doc: PDFDocument,
    private provider: FontBytesProvider,
  ) {}

  private installedFont(ref: InstalledFontRef, bold: boolean, italic: boolean) {
    const cacheKey = `${ref.family}|${ref.face ?? ''}|${bold}|${italic}`;
    let entry = this.installed.get(cacheKey);
    if (!entry) {
      entry = (async () => {
        const found = await this.provider.installedFont?.(ref, bold, italic);
        if (!found) return null;
        try {
          return { ...found, font: fontkit.create(found.bytes) };
        } catch {
          return null;
        }
      })();
      this.installed.set(cacheKey, entry);
    }
    return entry;
  }

  /** Embeds an installed font, subset if possible (some fonts don't subset cleanly). */
  private embedInstalled(key: string, bytes: Uint8Array): Promise<PDFFont> {
    if (!this.fonts.has(key)) {
      this.fonts.set(
        key,
        this.doc.embedFont(bytes, { subset: true }).catch(() => this.doc.embedFont(bytes, { subset: false })),
      );
    }
    return this.fonts.get(key)!;
  }

  async get(obj: TextObject): Promise<PDFFont> {
    const { bold, italic, font } = obj.style;
    if (font) {
      // The installed font, unless it's missing or lacks some of the characters.
      const installed = await this.installedFont(font, bold, italic);
      if (installed && fontCoversText(installed.font, obj.text)) {
        try {
          return await this.embedInstalled(`installed-${installed.key}`, installed.bytes);
        } catch {
          // Fall through to the standard fonts.
        }
      }
    }
    if (needsUnicodeFont(obj.text)) {
      const key = `unicode-${bold}-${italic}`;
      if (!this.fonts.has(key)) {
        this.fonts.set(
          key,
          this.provider.unicodeFont(bold, italic).then((bytes) => this.doc.embedFont(bytes, { subset: true })),
        );
      }
      return this.fonts.get(key)!;
    }
    const name = standardFontName(obj.style);
    if (!this.fonts.has(name)) this.fonts.set(name, this.doc.embedFont(name as StandardFonts));
    return this.fonts.get(name)!;
  }
}

/** Draws a text object into the page's content stream. */
export function drawIntoPage(page: PDFPage, obj: TextObject, font: PDFFont): void {
  const text = normalizeText(obj.text);
  const size = obj.style.size;
  const measure = lineMeasure(obj, (s) => font.widthOfTextAtSize(s, size));
  const lines = layoutLines(text, obj.wrapWidth, measure);
  const metrics = boxMetrics(obj, lines.length);
  const rad = (obj.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toUser = (lx: number, ly: number) => ({ x: obj.x + lx * cos - ly * sin, y: obj.y + lx * sin + ly * cos });
  const hScale = obj.hScale ?? 1;
  const charSpacing = obj.charSpacing ?? 0;

  if (obj.background) {
    const width = obj.wrapWidth ?? Math.max(0, ...lines.map(measure));
    const pad = 1;
    const corner = toUser(-pad, metrics.bottom);
    page.drawRectangle({
      ...corner,
      width: width + 2 * pad,
      height: metrics.top - metrics.bottom,
      rotate: degrees(obj.angle),
      color: rgb(...obj.background),
    });
  }
  // Horizontal scale (Tz) and character spacing (Tc) are graphics state, so they
  // carry into each drawText; Tc is in text space, i.e. before the Tz scaling.
  const scaled = hScale !== 1 || charSpacing !== 0;
  if (scaled) {
    page.pushOperators(pushGraphicsState(), setCharacterSqueeze(hScale * 100), setCharacterSpacing(charSpacing / hScale));
  }
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    page.drawText(line, {
      ...toUser(0, -i * metrics.lineAdvance),
      size,
      font,
      color: rgb(...obj.style.color),
      rotate: degrees(obj.angle),
    });
  });
  if (scaled) page.pushOperators(popGraphicsState());
}

export interface ExportOptions {
  /** Write every text box into the page content instead of as annotations. */
  flatten: boolean;
}

/** Produces the final PDF from the working copy plus the edited text objects. */
export async function exportDocument(
  workingBytes: Uint8Array,
  objects: TextObject[],
  originals: OriginalAnnotation[],
  hiddenKeys: Iterable<string>,
  options: ExportOptions,
  fonts: FontBytesProvider,
): Promise<Uint8Array> {
  const doc = await loadEditable(workingBytes);
  doc.registerFontkit(fontkit);
  const fontCache = new FontCache(doc, fonts);
  const hidden = new Set(hiddenKeys);
  const byKey = new Map(objects.filter((o) => o.annotKey).map((o) => [o.annotKey!, o]));
  const touched = new Set<number>();
  const live = objects.filter((o) => o.text.trim() !== '');

  for (const original of originals) {
    const dict = annotationByKey(doc, original.key);
    if (!dict) continue;
    const obj = byKey.get(original.key);
    const page = doc.getPage(original.pageIndex);
    if (!obj || obj.text.trim() === '' || options.flatten) {
      deleteAnnotation(doc, original.key);
      touched.add(original.pageIndex);
      if (obj && obj.text.trim() !== '') drawIntoPage(page, obj, await fontCache.get(obj));
      continue;
    }
    if (objectChanged(obj, original.object)) {
      writeFreeText(doc, page, { ...obj, text: normalizeText(obj.text) }, await fontCache.get(obj), dict);
    } else if (hidden.has(original.key)) {
      setAnnotationsHidden(doc, [original.key], false);
    }
  }

  for (const obj of live) {
    if (obj.annotKey) continue;
    const page = doc.getPage(obj.pageIndex);
    const font = await fontCache.get(obj);
    if (obj.kind === 'content' || options.flatten) {
      drawIntoPage(page, obj, font);
    } else {
      const dict = writeFreeText(doc, page, { ...obj, text: normalizeText(obj.text) }, font);
      page.node.addAnnot(doc.context.register(dict));
    }
  }

  for (const pageIndex of touched) compactAnnotations(doc.getPage(pageIndex));
  doc.setModificationDate(new Date());
  pruneUnreachableObjects(doc);
  return doc.save({ addDefaultPage: false, updateFieldAppearances: false });
}
