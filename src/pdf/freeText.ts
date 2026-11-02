import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFFont,
} from 'pdf-lib';
import {
  ANNOTATION_PADDING,
  DEFAULT_LINE_HEIGHT,
  type FontFamily,
  type InstalledFontRef,
  type OriginalAnnotation,
  type RGB,
  type TextObject,
  type TextStyle,
} from '../model/types';
import { familyCandidates, standardFontFor, stripSubsetTag } from './fontMatch';
import { classifyFont } from './fonts';
import { boxMetrics, layoutLines, lineMeasure } from './layout';
import { formatNumber, parseContentStream } from './lexer';
import { applyToPoint, boundsOf, type Matrix, type Point } from './matrix';
import { arrayNumbers, dictGet, getArray, getDict, getName, getNumber, getText, resolve, streamBytes } from './objects';

const FLAG_HIDDEN = 2;
const FLAG_PRINT = 4;
const FLAG_NO_VIEW = 32;

/** Acrobat's conventional resource names for the standard fonts. */
const ACROBAT_FONT_NAMES: Record<string, [FontFamily, boolean, boolean]> = {
  Helv: ['Helvetica', false, false],
  HeBo: ['Helvetica', true, false],
  HeOb: ['Helvetica', false, true],
  HeBO: ['Helvetica', true, true],
  TiRo: ['Times', false, false],
  TiBo: ['Times', true, false],
  TiIt: ['Times', false, true],
  TiBI: ['Times', true, true],
  Cour: ['Courier', false, false],
  CoBo: ['Courier', true, false],
  CoOb: ['Courier', false, true],
  CoBO: ['Courier', true, true],
};

function acrobatFontName(style: Pick<TextStyle, 'family' | 'bold' | 'italic'>): string {
  for (const [name, [family, bold, italic]] of Object.entries(ACROBAT_FONT_NAMES)) {
    if (family === style.family && bold === style.bold && italic === style.italic) return name;
  }
  return 'Helv';
}

export function annotationKey(pageIndex: number, arrayIndex: number): string {
  return `${pageIndex}:${arrayIndex}`;
}

/** Looks up an annotation dictionary by key ("page:index"). */
export function annotationByKey(doc: PDFDocument, key: string): PDFDict | undefined {
  const [pageIndex, arrayIndex] = key.split(':').map(Number);
  if (!(pageIndex >= 0 && pageIndex < doc.getPageCount())) return undefined;
  const annots = doc.getPage(pageIndex).node.Annots();
  const annot = annots ? resolve(doc.context, annots.get(arrayIndex)) : undefined;
  return annot instanceof PDFDict ? annot : undefined;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ParsedStyle {
  size?: number;
  color?: RGB;
  fontName?: string;
  family?: string;
  bold?: boolean;
  italic?: boolean;
}

function parseDA(da: string | undefined): ParsedStyle {
  if (!da) return {};
  const out: ParsedStyle = {};
  for (const { op, operands } of parseContentStream(new TextEncoder().encode(da))) {
    const nums = operands.filter((o) => o.type === 'number').map((o) => (o as { value: number }).value);
    if (op === 'Tf') {
      const name = operands[0];
      if (name?.type === 'name') out.fontName = name.value;
      if (nums[0] > 0) out.size = nums[0];
    } else if (op === 'g' && nums.length >= 1) {
      out.color = [nums[0], nums[0], nums[0]];
    } else if (op === 'rg' && nums.length >= 3) {
      out.color = [nums[0], nums[1], nums[2]];
    } else if (op === 'k' && nums.length >= 4) {
      const [c, m, y, k] = nums;
      out.color = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
  }
  return out;
}

function parseCssColor(value: string): RGB | undefined {
  const hex = value.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
  }
  const rgbFn = value.match(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbFn) return [rgbFn[1], rgbFn[2], rgbFn[3]].map((v) => Number(v) / 255) as RGB;
  return undefined;
}

/** Parses the CSS-like declarations used in /DS and in /RC style attributes. */
function parseCss(css: string | undefined): ParsedStyle {
  if (!css) return {};
  const out: ParsedStyle = {};
  for (const decl of css.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop === 'font') {
      const size = value.match(/([\d.]+)\s*pt/);
      if (size) out.size = Number(size[1]);
      if (/\bbold\b/i.test(value)) out.bold = true;
      if (/\bitalic\b|\boblique\b/i.test(value)) out.italic = true;
      // Both "12pt Helvetica" and Acrobat's "Helvetica,sans-serif 12.0pt" occur.
      const family = value
        .replace(/[\d.]+\s*pt(\/[\d.]+\w*)?/i, '')
        .replace(/\b(bold|bolder|italic|oblique|normal|\d{3})\b/gi, '')
        .trim();
      if (family) out.family = family;
    } else if (prop === 'font-size') {
      const size = parseFloat(value);
      if (size > 0) out.size = size;
    } else if (prop === 'font-family') {
      out.family = value;
    } else if (prop === 'font-weight') {
      out.bold = value === 'bold' || parseInt(value, 10) >= 600;
    } else if (prop === 'font-style') {
      out.italic = /italic|oblique/i.test(value);
    } else if (prop === 'color') {
      out.color = parseCssColor(value) ?? out.color;
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function richTextToPlain(rc: string): string {
  const text = rc
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).replace(/\n+$/, '');
}

function richTextStyle(rc: string): ParsedStyle {
  const styles = [...rc.matchAll(/style\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  return styles.reduce<ParsedStyle>((acc, css) => ({ ...acc, ...stripUndefined(parseCss(css)) }), {});
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface NamedFont {
  family: FontFamily;
  bold?: boolean;
  italic?: boolean;
  /** Set when the name isn't a standard PDF font: an installed font to look up. */
  font?: InstalledFontRef;
}

/** CSS family names we write for the standard fonts (see `cssFamily`). */
const STANDARD_CSS: Record<string, FontFamily> = { helvetica: 'Helvetica', times: 'Times', courier: 'Courier' };

/**
 * Interprets a font name from /DS or /RC (`kind: 'css'`, a family name such as
 * "Times New Roman") or from /DA (`kind: 'postscript'`, e.g. "Arial-BoldMT").
 */
function fontFromName(name: string | undefined, kind: 'css' | 'postscript'): NamedFont | undefined {
  if (!name) return undefined;
  const acrobat = ACROBAT_FONT_NAMES[name];
  if (acrobat) return { family: acrobat[0], bold: acrobat[1], italic: acrobat[2] };
  const first = (kind === 'css' ? name.split(',')[0] : name).replace(/['"]/g, '').trim();
  if (!first) return undefined;
  const standard = STANDARD_CSS[first.toLowerCase()] ?? standardFontFor(first)?.family;
  if (standard) {
    const exact = standardFontFor(first);
    return { family: standard, bold: exact?.bold, italic: exact?.italic };
  }
  const classified = classifyFont(first, undefined);
  if (kind === 'css') return { family: classified.family, font: { family: first } };
  const candidates = familyCandidates({ postscriptName: first });
  return {
    family: classified.family,
    bold: classified.bold,
    italic: classified.italic,
    font: { family: candidates[candidates.length - 1], face: stripSubsetTag(first) },
  };
}

function borderWidth(annot: PDFDict): number {
  const bs = getDict(annot, 'BS');
  const w = getNumber(bs, 'W');
  if (w !== undefined) return w;
  const border = arrayNumbers(annot.context, getArray(annot, 'Border'));
  if (border.length >= 3) return border[2];
  return 0;
}

/** Reads the FreeText annotations of a document into editable text objects. */
export function readFreeTextAnnotations(doc: PDFDocument, newId: () => string): OriginalAnnotation[] {
  const out: OriginalAnnotation[] = [];
  const acroFonts = getDict(getDict(doc.catalog, 'AcroForm'), 'DR');

  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = resolve(doc.context, annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      if (getName(annot, 'Subtype') !== 'FreeText') continue;
      const flags = getNumber(annot, 'F') ?? 0;
      if (flags & (FLAG_HIDDEN | FLAG_NO_VIEW)) continue;
      try {
        const object = parseFreeText(doc, annot, pageIndex, annotationKey(pageIndex, i), newId(), acroFonts);
        if (!object) continue;
        const ap = getDict(annot, 'AP');
        out.push({
          key: object.annotKey!,
          pageIndex,
          object,
          hasAppearance: dictGet(ap, 'N') !== undefined,
        });
      } catch {
        // A malformed annotation is left untouched.
      }
    }
  });
  return out;
}

function parseFreeText(
  doc: PDFDocument,
  annot: PDFDict,
  pageIndex: number,
  key: string,
  id: string,
  acroResources: PDFDict | undefined,
): TextObject | null {
  const rc = getText(annot, 'RC') ?? streamText(annot, 'RC');
  let text = getText(annot, 'Contents');
  if ((text === undefined || text === '') && rc) text = richTextToPlain(rc);
  if (!text) return null;
  text = text.replace(/\r\n?/g, '\n');

  const da = parseDA(getText(annot, 'DA'));
  const ds = parseCss(getText(annot, 'DS'));
  const rich = rc ? richTextStyle(rc) : {};
  const merged: ParsedStyle = { ...stripUndefined(da), ...stripUndefined(ds), ...stripUndefined(rich) };

  // Font: DS/RC family → DA font (Acrobat name, or BaseFont via AcroForm /DR) → Helvetica.
  let variant = fontFromName(merged.family, 'css');
  if (!variant && da.fontName) {
    const baseFont = getName(getDict(getDict(acroResources, 'Font'), da.fontName), 'BaseFont');
    // Plain resource names ("F1", "TT0") without a /DR entry say nothing about the font.
    variant = ACROBAT_FONT_NAMES[da.fontName] ? fontFromName(da.fontName, 'postscript') : fontFromName(baseFont, 'postscript');
  }
  const style: TextStyle = {
    family: variant?.family ?? 'Helvetica',
    ...(variant?.font ? { font: variant.font } : {}),
    bold: merged.bold ?? variant?.bold ?? false,
    italic: merged.italic ?? variant?.italic ?? false,
    size: merged.size && merged.size > 0 ? merged.size : 12,
    color: merged.color ?? [0, 0, 0],
  };

  const rect = arrayNumbers(doc.context, getArray(annot, 'Rect'));
  if (rect.length < 4) return null;
  const rd = arrayNumbers(doc.context, getArray(annot, 'RD'));
  let [x1, y1, x2, y2] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (rd.length === 4) {
    x1 += rd[0];
    y2 -= rd[1];
    x2 -= rd[2];
    y1 += rd[3];
  }

  const rotation = (((getNumber(annot, 'Rotate') ?? 0) % 360) + 360) % 360;
  const rad = (rotation * Math.PI) / 180;
  const u: Point = [Math.cos(rad), Math.sin(rad)];
  const v: Point = [-Math.sin(rad), Math.cos(rad)];
  const corners: Point[] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  // Top-left in the text's own frame: furthest against u, furthest along v.
  const topLeft = corners.reduce((best, p) =>
    p[0] * u[0] + p[1] * u[1] - (p[0] * v[0] + p[1] * v[1]) <
    best[0] * u[0] + best[1] * u[1] - (best[0] * v[0] + best[1] * v[1])
      ? p
      : best,
  );
  const innerWidth = Math.abs(rotation % 180 === 0 ? x2 - x1 : y2 - y1);

  const pad = ANNOTATION_PADDING + borderWidth(annot);
  const lineHeight = DEFAULT_LINE_HEIGHT;
  const metrics = boxMetrics({ style, lineHeight }, 1);
  const x = topLeft[0] + u[0] * pad - v[0] * (pad + metrics.top);
  const y = topLeft[1] + u[1] * pad - v[1] * (pad + metrics.top);

  const typewriter = getName(annot, 'IT') === 'FreeTextTypeWriter';
  const wrap = innerWidth - 2 * pad;
  return {
    id,
    pageIndex,
    kind: 'annotation',
    text,
    x,
    y,
    angle: rotation,
    style,
    lineHeight,
    wrapWidth: typewriter || wrap < style.size ? null : wrap,
    background: null,
    annotKey: key,
  };
}

function streamText(dict: PDFDict, key: string): string | undefined {
  const v = dictGet(dict, key);
  const bytes = v instanceof PDFStream ? streamBytes(v) : null;
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** Sets or clears the Hidden flag of annotations (used while one is being edited). */
export function setAnnotationsHidden(doc: PDFDocument, keys: Iterable<string>, hidden: boolean): void {
  for (const key of keys) {
    const annot = annotationByKey(doc, key);
    if (!annot) continue;
    const flags = getNumber(annot, 'F') ?? 0;
    const next = hidden ? flags | FLAG_HIDDEN : flags & ~FLAG_HIDDEN;
    annot.set(PDFName.of('F'), PDFNumber.of(next));
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function hex2(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');
}

export function cssHex(color: RGB): string {
  return '#' + color.map(hex2).join('').toUpperCase();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Family name written to /DS and /RC; read back by `fontFromName`. */
function cssFamily(style: Pick<TextStyle, 'family' | 'font'>): string {
  if (style.font) return /^[A-Za-z0-9-]+$/.test(style.font.family) ? style.font.family : `'${style.font.family}'`;
  return style.family;
}

/** Resource name used in /DA (informational for other viewers). */
function daFontName(style: TextStyle): string {
  if (style.font) return (style.font.face ?? style.font.family).replace(/[^A-Za-z0-9+-]/g, '') || 'Helv';
  return acrobatFontName(style);
}

function richText(obj: TextObject): string {
  const { style } = obj;
  const css =
    `font-size:${formatNumber(style.size)}pt;text-align:left;color:${cssHex(style.color)};` +
    `font-weight:${style.bold ? 'bold' : 'normal'};font-style:${style.italic ? 'italic' : 'normal'};` +
    `font-family:${cssFamily(style)};font-stretch:normal`;
  const paragraphs = obj.text
    .split('\n')
    .map((line) => `<p dir="ltr">${line ? escapeXml(line) : '<br/>'}</p>`)
    .join('');
  return (
    '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" ' +
    'xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" ' +
    `style="${css}">${paragraphs}</body>`
  );
}

function formatDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

function rgbOperator(color: RGB, op: 'rg' | 'RG'): string {
  return `${color.map((c) => formatNumber(Math.round(c * 1000) / 1000)).join(' ')} ${op}`;
}

/**
 * Writes a text object as a FreeText annotation, updating `existing` in place
 * when given (other entries such as author and dates are preserved).
 */
export function writeFreeText(
  doc: PDFDocument,
  page: PDFPage,
  obj: TextObject,
  font: PDFFont,
  existing?: PDFDict,
): PDFDict {
  const context = doc.context;
  const size = obj.style.size;
  const measure = lineMeasure(obj, (s) => font.widthOfTextAtSize(s, size));
  const lines = layoutLines(obj.text, obj.wrapWidth, measure);
  const metrics = boxMetrics(obj, lines.length);
  const contentWidth = obj.wrapWidth ?? Math.max(0, ...lines.map(measure));
  const hScale = obj.hScale ?? 1;
  const charSpacing = obj.charSpacing ?? 0;
  const pad = ANNOTATION_PADDING;
  const bbox: [number, number, number, number] = [-pad, metrics.bottom - pad, contentWidth + pad, metrics.top + pad];

  const rad = (obj.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const matrix: Matrix = [cos, sin, -sin, cos, obj.x, obj.y];
  const rect = boundsOf(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[1]],
      [bbox[2], bbox[3]],
      [bbox[0], bbox[3]],
    ].map(([px, py]) => applyToPoint(matrix, px, py)),
  );

  let content = 'q\n';
  if (obj.background) {
    content += `${rgbOperator(obj.background, 'rg')} ${bbox.slice(0, 2).map(formatNumber).join(' ')} ` +
      `${formatNumber(bbox[2] - bbox[0])} ${formatNumber(bbox[3] - bbox[1])} re f\n`;
  }
  content += `BT /F0 ${formatNumber(size)} Tf ${rgbOperator(obj.style.color, 'rg')}\n`;
  if (hScale !== 1) content += `${formatNumber(hScale * 100)} Tz\n`;
  if (charSpacing !== 0) content += `${formatNumber(charSpacing / hScale)} Tc\n`;
  lines.forEach((line, i) => {
    content += i === 0 ? '0 0 Td ' : `0 ${formatNumber(-metrics.lineAdvance)} Td `;
    content += `${line ? font.encodeText(line).toString() : '<>'} Tj\n`;
  });
  content += 'ET\nQ\n';

  const appearance = context.flateStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: bbox.map((n) => Math.round(n * 1000) / 1000),
    Matrix: matrix.map((n) => Math.round(n * 10000) / 10000),
    Resources: { Font: { F0: font.ref } },
  });
  const apRef = context.register(appearance);

  const annot = existing ?? context.obj({});
  const set = (key: string, value: Parameters<PDFDict['set']>[1]) => annot.set(PDFName.of(key), value);
  set('Type', PDFName.of('Annot'));
  set('Subtype', PDFName.of('FreeText'));
  set('Rect', context.obj(rect.map((n) => Math.round(n * 1000) / 1000)));
  set('Contents', PDFHexString.fromText(obj.text.replace(/\n/g, '\r')));
  set('DA', PDFString.of(`/${daFontName(obj.style)} ${formatNumber(size)} Tf ${rgbOperator(obj.style.color, 'rg')}`));
  set(
    'DS',
    PDFString.of(
      `font: ${obj.style.bold ? 'bold ' : ''}${obj.style.italic ? 'italic ' : ''}${formatNumber(size)}pt ${cssFamily(obj.style)}; ` +
        `text-align:left; color:${cssHex(obj.style.color)}`,
    ),
  );
  set('RC', PDFHexString.fromText(richText(obj)));
  set('AP', context.obj({ N: apRef }));
  set('F', PDFNumber.of(((getNumber(annot, 'F') ?? FLAG_PRINT) | FLAG_PRINT) & ~(FLAG_HIDDEN | FLAG_NO_VIEW)));
  set('M', PDFString.of(formatDate(new Date())));
  set('P', page.ref);
  set('BS', context.obj({ W: 0 }));
  set('Border', context.obj([0, 0, 0]));
  annot.delete(PDFName.of('RD'));
  annot.delete(PDFName.of('AS'));
  if (obj.wrapWidth === null) set('IT', PDFName.of('FreeTextTypeWriter'));
  else annot.delete(PDFName.of('IT'));
  if (rotationIsQuarterTurn(obj.angle)) set('Rotate', PDFNumber.of(((Math.round(obj.angle / 90) * 90) % 360 + 360) % 360));
  else annot.delete(PDFName.of('Rotate'));
  if (!existing) {
    set('NM', PDFString.of(`pdf-edit-${obj.id}`));
    set('CreationDate', PDFString.of(formatDate(new Date())));
  }
  return annot;
}

function rotationIsQuarterTurn(angle: number): boolean {
  const r = ((angle % 360) + 360) % 360;
  return r > 0.01 && Math.abs(r / 90 - Math.round(r / 90)) < 1e-3;
}

/** Removes an annotation (and its popup) from its page. */
export function deleteAnnotation(doc: PDFDocument, key: string): void {
  const [pageIndex, arrayIndex] = key.split(':').map(Number);
  const page = doc.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) return;
  const annot = resolve(doc.context, annots.get(arrayIndex));
  const popup = annot instanceof PDFDict ? annot.get(PDFName.of('Popup')) : undefined;
  // Replace with null rather than splicing so other keys ("page:index") stay valid.
  annots.set(arrayIndex, doc.context.obj(null));
  if (popup instanceof PDFRef) {
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && entry.objectNumber === popup.objectNumber) annots.set(i, doc.context.obj(null));
    }
  }
}

/** Drops null entries left behind by `deleteAnnotation`. */
export function compactAnnotations(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  const kept = [];
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    if (entry && entry.toString() !== 'null') kept.push(entry);
  }
  page.node.set(PDFName.of('Annots'), page.node.context.obj(kept));
}
