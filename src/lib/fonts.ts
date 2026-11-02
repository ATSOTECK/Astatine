import type { FontFamily, TextStyle } from '../model/types';
import { fontCoversText, needsUnicodeFont, normalizeText, type FontBytesProvider } from '../pdf/session';
import { measureStandardText } from '../pdf/standardFonts';
import { installedFontBytes, resolveInstalledFont, type LoadedFace } from './installedFonts';

/**
 * Fonts on screen must match what gets written to the PDF. The standard PDF
 * fonts map to metric-compatible system fonts; text the standard fonts can't
 * encode uses Liberation Sans (shipped with pdf.js) both on screen and in the
 * saved file.
 */

const UNICODE_FAMILY = 'PDF Editor Unicode';

const STACKS: Record<FontFamily, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", "Nimbus Roman", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", "Nimbus Mono PS", monospace',
};

export const FAMILY_LABELS: Record<FontFamily, string> = {
  Helvetica: 'Helvetica',
  Times: 'Times',
  Courier: 'Courier',
};

function variantFile(bold: boolean, italic: boolean): string {
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return new URL(`/pdfjs/standard_fonts/LiberationSans-${style}.ttf`, window.location.href).href;
}

let registered = false;
export function registerUnicodeFontFaces(): void {
  if (registered || typeof FontFace === 'undefined') return;
  registered = true;
  for (const bold of [false, true]) {
    for (const italic of [false, true]) {
      const face = new FontFace(UNICODE_FAMILY, `url("${variantFile(bold, italic)}")`, {
        weight: bold ? '700' : '400',
        style: italic ? 'italic' : 'normal',
      });
      document.fonts.add(face);
    }
  }
}

export interface CssFont {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
}

export function cssFont(style: Pick<TextStyle, 'family' | 'bold' | 'italic'>, unicode: boolean): CssFont {
  return {
    fontFamily: unicode ? `"${UNICODE_FAMILY}", ${STACKS.Helvetica}` : STACKS[style.family],
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
  };
}

export interface DisplayFont {
  css: CssFont;
  /** The text is drawn with Liberation Sans because the chosen font can't show all of it. */
  unicodeFallback: boolean;
  /** The style names an installed font that isn't available here. */
  installedMissing: boolean;
}

/**
 * The CSS font that shows exactly what saving will write: the installed face
 * itself when it covers the text, otherwise the same fallbacks the exporter uses.
 * `installed` comes from `useInstalledFont` (undefined while loading).
 */
export function displayFont(style: TextStyle, text: string, installed: LoadedFace | null | undefined): DisplayFont {
  if (style.font && installed) {
    if (fontCoversText(installed.font, text)) {
      // The registered face is already bold/italic; don't let the browser fake it again.
      return { css: { fontFamily: `"${installed.cssFamily}"`, fontWeight: 400, fontStyle: 'normal' }, unicodeFallback: false, installedMissing: false };
    }
  } else if (style.font && installed === undefined) {
    // Still loading: approximate with the system font of that name.
    const css = cssFont(style, false);
    return { css: { ...css, fontFamily: `"${style.font.family}", ${css.fontFamily}` }, unicodeFallback: false, installedMissing: false };
  }
  const unicode = needsUnicodeFont(text);
  return { css: cssFont(style, unicode), unicodeFallback: unicode, installedMissing: !!style.font && installed === null };
}

/**
 * Natural width of a line of text in a style (no horizontal scale or
 * tracking), measured with the font that saving would use.
 */
export async function naturalTextWidth(style: TextStyle, text: string): Promise<number> {
  const line = normalizeText(text);
  if (style.font) {
    const face = await resolveInstalledFont(style.font, style.bold, style.italic);
    if (face && fontCoversText(face.font, line)) {
      // Glyph advances without kerning, as pdf-lib writes them.
      const units = face.font.layout(line).glyphs.reduce((w, g) => w + g.advanceWidth, 0);
      return (units / face.font.unitsPerEm) * style.size;
    }
  }
  // Liberation Sans (the Unicode fallback) has Helvetica's metrics.
  const variant = needsUnicodeFont(line) ? { ...style, family: 'Helvetica' as const } : style;
  return measureStandardText(line, variant, style.size);
}

const baselineCache = new Map<string, number>();

/**
 * Distance from the top of a CSS line box to the alphabetic baseline, as a
 * fraction of the font size, measured from real layout.
 */
export function baselineRatio(font: CssFont, lineHeight: number): number {
  const key = `${font.fontFamily}|${font.fontWeight}|${font.fontStyle}|${lineHeight}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute',
    visibility: 'hidden',
    left: '-10000px',
    top: '0',
    margin: '0',
    padding: '0',
    whiteSpace: 'pre',
    fontFamily: font.fontFamily,
    fontWeight: String(font.fontWeight),
    fontStyle: font.fontStyle,
    fontSize: '100px',
    lineHeight: String(lineHeight),
  });
  const marker = document.createElement('span');
  Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
  box.append(document.createTextNode('Hg'), marker);
  document.body.append(box);
  const ratio = marker.offsetTop / 100;
  box.remove();

  baselineCache.set(key, ratio);
  return ratio;
}

/** Forget measurements once web fonts finish loading. */
export function resetFontMeasurements(): void {
  baselineCache.clear();
}

const fontBytes = new Map<string, Promise<Uint8Array>>();

export const fontProvider: FontBytesProvider = {
  installedFont: installedFontBytes,
  unicodeFont(bold, italic) {
    const url = variantFile(bold, italic);
    let bytes = fontBytes.get(url);
    if (!bytes) {
      bytes = fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`Could not load font ${url}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      fontBytes.set(url, bytes);
    }
    return bytes;
  },
};
