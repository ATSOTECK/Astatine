import type { PDFDocument } from 'pdf-lib';
import { DEFAULT_LINE_HEIGHT, type RGB, type TextObject } from '../model/types';
import type { SourceFontInfo } from './fontMatch';
import { interpretPage, type Glyph } from './interpreter';
import { normalizeDegrees } from './matrix';
import { removeGlyphsFromPage } from './rewrite';

/** The parts of a pdf.js text item that describe where it is on the page. */
export interface TextItemGeometry {
  str: string;
  /** pdf.js text item transform (page user space). */
  transform: number[];
  width: number;
  height: number;
}

/**
 * Finds the glyphs drawn inside a pdf.js text item: same orientation,
 * similar size, and centred within the item's box.
 */
export function selectGlyphsForItem(glyphs: Glyph[], item: TextItemGeometry): Glyph[] {
  const [a, b, c, d, e, f] = item.transform;
  const ul = Math.hypot(a, b) || 1;
  const ux = a / ul;
  const uy = b / ul;
  const vl = Math.hypot(c, d) || 1;
  const vx = c / vl;
  const vy = d / vl;
  const h = item.height || vl;
  const w = item.width;
  const itemAngle = (Math.atan2(b, a) * 180) / Math.PI;

  return glyphs.filter((g) => {
    if (Math.abs(normalizeDegrees(g.angle - itemAngle)) > 5) return false;
    if (g.size < h * 0.55 || g.size > h * 1.8) return false;
    const dx = g.center[0] - e;
    const dy = g.center[1] - f;
    const s = dx * ux + dy * uy;
    const t = dx * vx + dy * vy;
        // Glyph centres lie strictly inside the item; the right edge is kept tight
    // because kerning can make the next item's first glyph overlap this one.
    return s >= -0.1 * h && s <= w + 0.02 * h && t >= -0.35 * h && t <= 0.95 * h;
  });
}

function mostCommon<T>(values: T[], key: (v: T) => string): T {
  const counts = new Map<string, { value: T; count: number }>();
  for (const v of values) {
    const k = key(v);
    const entry = counts.get(k);
    if (entry) entry.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  let best = values[0];
  let bestCount = 0;
  for (const { value, count } of counts.values()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * pdf.js inserts a space between the letters of widely tracked text
 * ("T r a c k e d o u t"), which also hides the real word breaks. When the
 * tracking is wide enough for that to happen, rebuild the text from the
 * glyphs: real space glyphs become spaces, every other glyph takes the next
 * letter of pdf.js's text.
 */
export function cleanItemText(str: string, glyphs: Glyph[]): string {
  if (!glyphs.length || !str.includes(' ')) return str;
  const tracking = Math.abs(median(glyphs.map((g) => g.charSpacing)));
  const size = median(glyphs.map((g) => g.size));
  if (!(tracking >= 0.09 * size)) return str;
  const letters = [...str].filter((ch) => ch !== ' ');
  const spaces = glyphs.map(isSpaceGlyph);
  if (letters.length !== spaces.filter((sp) => !sp).length) return str; // ligatures etc.: leave as is
  let k = 0;
  return spaces.map((sp) => (sp ? ' ' : letters[k++])).join('').replace(/ +/g, ' ').trim();
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function isSpaceGlyph(g: Glyph): boolean {
  let index = 0;
  for (const el of g.show.elements) {
    if (el.kind !== 'glyph') continue;
    if (index++ === g.glyphIndex) return el.wordSpace;
  }
  return false;
}

export interface ConversionResult {
  /** Editable replacement, styled with the closest standard font. */
  object: TextObject;
  /** The original font, for matching against installed fonts. */
  sourceFont: SourceFontInfo;
  /** Visual width of the original text along its baseline, in user units. */
  extent: number;
  removedGlyphs: number;
  /** True when the original text was invisible (e.g. the OCR layer of a scan). */
  invisibleText: boolean;
}

/**
 * Removes the glyphs of an existing text item from the page content and
 * returns an editable text object that reproduces it. Mutates `doc`.
 */
export function convertTextItem(
  doc: PDFDocument,
  pageIndex: number,
  item: TextItemGeometry,
  id: string,
): ConversionResult | null {
  const page = doc.getPage(pageIndex);
  const { root, glyphs } = interpretPage(page);
  const selected = selectGlyphsForItem(glyphs, item);
  if (selected.length === 0) return null;

  const removed = removeGlyphsFromPage(page, root, selected);
  if (removed === 0) return null;

  const [a, b, c, d, e, f] = item.transform;
  const font = mostCommon(selected, (g) => g.font.baseFont).font;
  const sizes = selected.map((g) => g.size).sort((x, y) => x - y);
  const size = sizes[Math.floor(sizes.length / 2)] || item.height || Math.hypot(c, d);
  const invisibleText = selected.every((g) => g.renderMode === 3 || g.renderMode === 7);
  const visible = selected.filter((g) => g.renderMode !== 3 && g.renderMode !== 7);
  const color: RGB = visible.length ? mostCommon(visible, (g) => g.color.join(',')).color : [0, 0, 0];

  const hScale = Math.round(median(selected.map((g) => g.hScale)) * 1000) / 1000;
  const charSpacing = Math.round(median(selected.map((g) => g.charSpacing)) * 1000) / 1000;

  // Visual width of the original run along its baseline, spacing and kerning included.
  const len = Math.hypot(a, b) || 1;
  const ux = a / len;
  const uy = b / len;
  let start = Infinity;
  let end = -Infinity;
  for (const g of selected) {
    const s0 = (g.origin[0] - e) * ux + (g.origin[1] - f) * uy;
    start = Math.min(start, s0);
    end = Math.max(end, s0 + g.advance);
  }

  const object: TextObject = {
    id,
    pageIndex,
    kind: 'content',
    text: cleanItemText(item.str, selected),
    x: e,
    y: f,
    angle: Math.round(((Math.atan2(b, a) * 180) / Math.PI) * 1000) / 1000,
    style: {
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      size: Math.round(size * 100) / 100,
      color,
    },
    lineHeight: DEFAULT_LINE_HEIGHT,
    wrapWidth: null,
    background: invisibleText ? [1, 1, 1] : null,
    ...(Math.abs(hScale - 1) >= 0.01 && hScale > 0 ? { hScale } : {}),
    ...(Math.abs(charSpacing) >= 0.01 ? { charSpacing } : {}),
  };
  const sourceFont: SourceFontInfo = {
    postscriptName: font.postscriptName,
    familyName: font.familyName,
    weight: font.weight,
    italic: font.italic,
  };
  return { object, sourceFont, extent: end > start ? end - start : item.width, removedGlyphs: removed, invisibleText };
}
