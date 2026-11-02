import { Encodings, Font, FontNames, type EncodingType } from '@pdf-lib/standard-fonts';
import type { FontFamily } from '../model/types';

export type { FontFamily };

/**
 * Helpers for the 14 standard PDF fonts: name normalisation, encodings and
 * AFM metrics. Used both to measure existing text (fonts without /Widths) and
 * to lay out the text we write.
 */

export type StandardFontName = `${FontNames}`;

export interface FontVariant {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

const fontCache = new Map<string, Font>();

export function loadStandardFont(name: StandardFontName): Font {
  let font = fontCache.get(name);
  if (!font) {
    font = Font.load(name as FontNames);
    fontCache.set(name, font);
  }
  return font;
}

export function standardFontName(v: FontVariant): StandardFontName {
  switch (v.family) {
    case 'Times':
      if (v.bold && v.italic) return 'Times-BoldItalic';
      if (v.bold) return 'Times-Bold';
      if (v.italic) return 'Times-Italic';
      return 'Times-Roman';
    case 'Courier':
      if (v.bold && v.italic) return 'Courier-BoldOblique';
      if (v.bold) return 'Courier-Bold';
      if (v.italic) return 'Courier-Oblique';
      return 'Courier';
    default:
      if (v.bold && v.italic) return 'Helvetica-BoldOblique';
      if (v.bold) return 'Helvetica-Bold';
      if (v.italic) return 'Helvetica-Oblique';
      return 'Helvetica';
  }
}

function codeToNameTable(encoding: EncodingType): (string | undefined)[] {
  const table: (string | undefined)[] = new Array(256);
  for (const cp of encoding.supportedCodePoints) {
    const { code, name } = encoding.encodeUnicodeCodePoint(cp);
    if (code >= 0 && code < 256 && table[code] === undefined) table[code] = name;
  }
  return table;
}

let winAnsiTable: (string | undefined)[] | null = null;
let symbolTable: (string | undefined)[] | null = null;
let dingbatsTable: (string | undefined)[] | null = null;

export function winAnsiGlyphNames(): (string | undefined)[] {
  return (winAnsiTable ??= codeToNameTable(Encodings.WinAnsi));
}
export function symbolGlyphNames(): (string | undefined)[] {
  return (symbolTable ??= codeToNameTable(Encodings.Symbol));
}
export function dingbatsGlyphNames(): (string | undefined)[] {
  return (dingbatsTable ??= codeToNameTable(Encodings.ZapfDingbats));
}

/** True if every character can be written with a standard font (WinAnsi encoding). */
export function isWinAnsiEncodable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d) continue;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) return false;
  }
  return true;
}

/** Characters that the standard fonts cannot encode (deduplicated). */
export function unencodableCharacters(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d) continue;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) out.add(ch);
  }
  return [...out];
}

/**
 * Maps a PDF BaseFont name (e.g. "ABCDEF+Arial,BoldItalic") to one of the 14
 * standard fonts when it is one of them or a well known alias.
 */
export function matchStandardFont(baseFont: string): StandardFontName | null {
  const name = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/[\s_]/g, '');
  const lower = name.toLowerCase();
  const bold = /bold|black|heavy/.test(lower);
  const italic = /italic|oblique/.test(lower);
  const base = lower.split(/[,-]/)[0];

  let family: FontFamily | null = null;
  if (['helvetica', 'arial', 'arialmt'].includes(base)) family = 'Helvetica';
  else if (['times', 'timesroman', 'timesnewroman', 'timesnewromanps', 'timesnewromanpsmt'].includes(base))
    family = 'Times';
  else if (['courier', 'couriernew', 'couriernewpsmt'].includes(base)) family = 'Courier';
  else if (base === 'symbol') return 'Symbol';
  else if (base === 'zapfdingbats') return 'ZapfDingbats';

  return family ? standardFontName({ family, bold, italic }) : null;
}

/** Width of text in a standard font, in user-space units. */
export function measureStandardText(text: string, v: FontVariant, size: number): number {
  const font = loadStandardFont(standardFontName(v));
  const names = winAnsiGlyphNames();
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let glyph: string | undefined;
    if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(cp)) {
      glyph = names[Encodings.WinAnsi.encodeUnicodeCodePoint(cp).code];
    }
    const w = glyph ? font.getWidthOfGlyph(glyph) : undefined;
    width += typeof w === 'number' ? w : 556;
  }
  return (width / 1000) * size;
}
