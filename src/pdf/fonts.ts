import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import { IDENTITY_CMAP, ONE_BYTE_CMAP, parseCMap, splitCodes, type CMap } from './cmap';
import { stripSubsetTag, weightFromName } from './fontMatch';
import {
  arrayItems,
  arrayNumbers,
  dictGet,
  dictOf,
  getArray,
  getDict,
  getName,
  getNumber,
  getText,
  streamBytes,
} from './objects';
import {
  dingbatsGlyphNames,
  loadStandardFont,
  matchStandardFont,
  symbolGlyphNames,
  winAnsiGlyphNames,
  type FontFamily,
} from './standardFonts';

/**
 * Everything the interpreter needs to know about a font to compute where
 * each glyph is drawn: how to split strings into codes and how wide each
 * code is. Text decoding is left to pdf.js.
 */
export interface FontInfo {
  baseFont: string;
  /** BaseFont without the subset prefix ("ABCDEF+Arial-BoldMT" → "Arial-BoldMT"). */
  postscriptName: string;
  /** /FontFamily from the font descriptor, when present. */
  familyName?: string;
  /** CSS-style weight (100–900). */
  weight: number;
  composite: boolean;
  /** Splits a string operand into [start, end, code] triples. */
  split(bytes: Uint8Array): [number, number, number][];
  /** Horizontal advance of a code in text space for a font size of 1. */
  width(code: number, length: number): number;
  /** Whether word spacing (Tw) applies to this code. */
  isWordSpace(code: number, length: number): boolean;
  /** Ascent/descent as fractions of the font size. */
  ascent: number;
  descent: number;
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

const cache = new WeakMap<PDFDict, FontInfo>();

export function getFontInfo(context: PDFContext, fontDict: PDFDict | undefined): FontInfo {
  if (!fontDict) return FALLBACK_FONT;
  let info = cache.get(fontDict);
  if (!info) {
    try {
      info = buildFontInfo(context, fontDict);
    } catch {
      info = FALLBACK_FONT;
    }
    cache.set(fontDict, info);
  }
  return info;
}

const FALLBACK_FONT: FontInfo = {
  baseFont: 'Unknown',
  postscriptName: 'Unknown',
  weight: 400,
  composite: false,
  split: (bytes) => [...bytes].map((b, i) => [i, i + 1, b] as [number, number, number]),
  width: () => 0.5,
  isWordSpace: (code, length) => length === 1 && code === 32,
  ascent: 0.8,
  descent: -0.2,
  family: 'Helvetica',
  bold: false,
  italic: false,
};

function buildFontInfo(context: PDFContext, dict: PDFDict): FontInfo {
  const subtype = getName(dict, 'Subtype') ?? 'Type1';
  const baseFont = getName(dict, 'BaseFont') ?? getName(dict, 'Name') ?? 'Unknown';
  if (subtype === 'Type0') return buildCompositeFont(context, dict, baseFont);
  return buildSimpleFont(context, dict, baseFont, subtype);
}

function sanitizeMetrics(descriptor: PDFDict | undefined, fallback?: { ascent: number; descent: number }) {
  let ascent = (getNumber(descriptor, 'Ascent') ?? 0) / 1000;
  let descent = (getNumber(descriptor, 'Descent') ?? 0) / 1000;
  if (!(ascent > 0.2 && ascent < 2)) ascent = fallback?.ascent ?? 0.8;
  if (!(descent < 0 && descent > -1)) descent = fallback?.descent ?? -0.2;
  return { ascent, descent };
}

function buildSimpleFont(context: PDFContext, dict: PDFDict, baseFont: string, subtype: string): FontInfo {
  const descriptor = getDict(dict, 'FontDescriptor');
  const firstChar = getNumber(dict, 'FirstChar') ?? 0;
  const widths = arrayNumbers(context, getArray(dict, 'Widths'));
  const missingWidth = getNumber(descriptor, 'MissingWidth') ?? 0;

  let scale = 0.001;
  if (subtype === 'Type3') {
    const fm = arrayNumbers(context, getArray(dict, 'FontMatrix'));
    scale = fm.length === 6 ? fm[0] : 0.001;
  }

  let width: (code: number) => number;
  const standard = matchStandardFont(baseFont);
  if (widths.length > 0) {
    width = (code) => {
      const w = widths[code - firstChar];
      return (w === undefined ? missingWidth : w) * scale;
    };
  } else if (standard) {
    const font = loadStandardFont(standard);
    const names = glyphNamesForEncoding(context, dict, standard);
    width = (code) => {
      const name = names[code];
      const w = name ? font.getWidthOfGlyph(name) : undefined;
      return (typeof w === 'number' ? w : 0) / 1000;
    };
  } else {
    const avg = getNumber(descriptor, 'AvgWidth') ?? (missingWidth || 500);
    width = () => avg / 1000;
  }

  let metricsFallback: { ascent: number; descent: number } | undefined;
  if (standard && standard !== 'Symbol' && standard !== 'ZapfDingbats') {
    const f = loadStandardFont(standard);
    metricsFallback = { ascent: (f.Ascender ?? 718) / 1000, descent: (f.Descender ?? -207) / 1000 };
  }
  const { ascent, descent } = sanitizeMetrics(descriptor, metricsFallback);

  return {
    baseFont,
    composite: false,
    split: (bytes) => {
      const out: [number, number, number][] = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = [i, i + 1, bytes[i]];
      return out;
    },
    width: (code) => width(code),
    isWordSpace: (code) => code === 32,
    ascent,
    descent,
    ...classifyFont(baseFont, descriptor),
  };
}

/** Code → glyph name for simple fonts that rely on built-in metrics. */
function glyphNamesForEncoding(context: PDFContext, dict: PDFDict, standard: string): (string | undefined)[] {
  let base: (string | undefined)[];
  if (standard === 'Symbol') base = symbolGlyphNames();
  else if (standard === 'ZapfDingbats') base = dingbatsGlyphNames();
  else base = winAnsiGlyphNames(); // close enough for Standard/MacRoman in the ASCII range
  const names = [...base];

  const encoding = dictGet(dict, 'Encoding');
  const encodingDict = dictOf(encoding);
  if (encodingDict) {
    const differences = getArray(encodingDict, 'Differences');
    let code = 0;
    for (const item of arrayItems(context, differences)) {
      if (item instanceof PDFNumber) code = item.asNumber();
      else if (item instanceof PDFName) names[code++] = item.decodeText();
    }
  }
  return names;
}

function buildCompositeFont(context: PDFContext, dict: PDFDict, baseFont: string): FontInfo {
  const descendant = dictOf(arrayItems(context, getArray(dict, 'DescendantFonts'))[0]);
  const descriptor = getDict(descendant, 'FontDescriptor');

  let cmap: CMap = IDENTITY_CMAP;
  const encoding = dictGet(dict, 'Encoding');
  if (encoding instanceof PDFName) {
    const name = encoding.decodeText();
    // Predefined CMaps other than Identity are rare in practice; most are two-byte.
    if (name.startsWith('OneByteIdentity')) cmap = ONE_BYTE_CMAP;
  } else if (encoding instanceof PDFStream) {
    const bytes = streamBytes(encoding);
    if (bytes) cmap = parseCMap(bytes);
  }

  const defaultWidth = getNumber(descendant, 'DW') ?? 1000;
  const widths = parseCidWidths(context, getArray(descendant, 'W'));
  const { ascent, descent } = sanitizeMetrics(descriptor);

  return {
    baseFont,
    composite: true,
    split: (bytes) => splitCodes(bytes, cmap.codespace),
    width: (code, length) => {
      const cid = cmap.toCid(code, length);
      return (widths.get(cid) ?? defaultWidth) / 1000;
    },
    isWordSpace: (code, length) => length === 1 && code === 32,
    ascent,
    descent,
    ...classifyFont(baseFont, descriptor),
  };
}

/** Parses a CIDFont /W array: `c [w1 w2 …]` or `cFirst cLast w`. */
function parseCidWidths(context: PDFContext, w: PDFArray | undefined): Map<number, number> {
  const map = new Map<number, number>();
  const items = arrayItems(context, w);
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    const second = items[i + 1];
    if (!(first instanceof PDFNumber)) {
      i++;
      continue;
    }
    const start = first.asNumber();
    if (second instanceof PDFArray) {
      const list = arrayNumbers(context, second);
      list.forEach((width, k) => map.set(start + k, width));
      i += 2;
    } else {
      const last = second instanceof PDFNumber ? second.asNumber() : start;
      const width = items[i + 2];
      const value = width instanceof PDFNumber ? width.asNumber() : 1000;
      // Guard against absurd ranges in malformed files.
      for (let cid = start; cid <= last && cid - start < 65536; cid++) map.set(cid, value);
      i += 3;
    }
  }
  return map;
}

const MONO = /courier|mono|consol|menlo|typewriter|fixed|inconsolata|lucidaconsole/;
const SERIF =
  /times|georgia|garamond|cambria|minion|palatino|caslon|baskerville|didot|bodoni|merriweather|charter|century|bookantiqua|bookman|constantia|perpetua|utopia|plantin|sabon|roman|serif/;
const SANS =
  /sans|arial|helvetica|calibri|verdana|tahoma|segoe|roboto|inter|gotham|futura|avenir|frutiger|myriad|lato|opensans|ubuntu|gill|franklin|trebuchet|candara|corbel|lucida|geneva|sf ?pro/;

/** Picks the closest standard family, weight and slant for a font, and its identity. */
export function classifyFont(baseFont: string, descriptor: PDFDict | undefined) {
  const name = stripSubsetTag(baseFont);
  const familyName = getText(descriptor, 'FontFamily')?.trim() || undefined;
  const lower = (name + ' ' + (familyName ?? '')).toLowerCase();
  const flags = getNumber(descriptor, 'Flags') ?? 0;
  const weight = getNumber(descriptor, 'FontWeight') ?? 0;
  const italicAngle = getNumber(descriptor, 'ItalicAngle') ?? 0;

  let family: FontFamily;
  if (MONO.test(lower)) family = 'Courier';
  else if (SANS.test(lower)) family = 'Helvetica';
  else if (SERIF.test(lower)) family = 'Times';
  else if (flags & 1) family = 'Courier';
  else if (flags & 2) family = 'Times';
  else family = 'Helvetica';

  const bold = /bold|black|heavy|semibold|demibold|extrab|ultrab/.test(lower) || weight >= 600 || (flags & 0x40000) !== 0;
  const italic = /italic|oblique|slanted/.test(lower) || (flags & 0x40) !== 0 || Math.abs(italicAngle) > 1;
  const cssWeight = weight >= 100 && weight <= 1000 ? weight : (weightFromName(name) ?? (bold ? 700 : 400));
  return { family, bold, italic, postscriptName: name, familyName, weight: cssWeight };
}
