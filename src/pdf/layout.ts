import type { TextObject } from '../model/types';

/**
 * Line breaking and vertical metrics shared by the PDF writer and the
 * annotation parser, so that reading back what we wrote is lossless.
 */

export type Measure = (text: string) => number;

/**
 * Width of a line as drawn: the font's natural width scaled horizontally, plus
 * character spacing after every character (as both CSS letter-spacing and
 * PDF Tc do).
 */
export function lineMeasure(
  obj: Pick<TextObject, 'hScale' | 'charSpacing'>,
  naturalWidth: Measure,
): Measure {
  const h = obj.hScale ?? 1;
  const c = obj.charSpacing ?? 0;
  if (h === 1 && c === 0) return naturalWidth;
  return (text) => naturalWidth(text) * h + c * [...text].length;
}

/**
 * Splits text into lines: hard breaks on "\n" and, when `wrapWidth` is set,
 * greedy word wrapping (long words are broken by character), mirroring
 * CSS `white-space: pre-wrap; overflow-wrap: anywhere`.
 */
export function layoutLines(text: string, wrapWidth: number | null, measure: Measure): string[] {
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  if (wrapWidth === null || !(wrapWidth > 0)) return paragraphs;

  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const tokens = paragraph.split(/(\s+)/).filter((t) => t !== '');
    let line = '';
    for (const token of tokens) {
      const candidate = line + token;
      if (measure(candidate.trimEnd()) <= wrapWidth + 0.01) {
        line = candidate;
        continue;
      }
      if (/^\s+$/.test(token)) {
        // Trailing whitespace "hangs" past the edge, then the line breaks.
        lines.push(line);
        line = '';
        continue;
      }
      if (line.trim() !== '') lines.push(line.trimEnd());
      line = token;
      // Break words that are wider than the box on their own.
      while (line.length > 1 && measure(line) > wrapWidth + 0.01) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > wrapWidth + 0.01) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export interface BoxMetrics {
  /** Distance from the first baseline up to the top of the box. */
  top: number;
  /** Distance from the first baseline down to the bottom of the box (negative). */
  bottom: number;
  /** Distance between baselines. */
  lineAdvance: number;
}

/**
 * Nominal ascent/descent used to size text boxes. Deliberately the same for
 * every font, so reading back a box we wrote gives exactly the same anchor
 * whatever font it uses; the box padding absorbs taller glyphs.
 */
const BOX_ASCENT = 0.8;
const BOX_DESCENT = -0.2;

/** Vertical extent of a text block in its local frame (y up, origin at first baseline). */
export function boxMetrics(obj: Pick<TextObject, 'style' | 'lineHeight'>, lineCount: number): BoxMetrics {
  const ascent = BOX_ASCENT;
  const descent = BOX_DESCENT;
  const size = obj.style.size;
  const lineAdvance = obj.lineHeight * size;
  const halfLeading = (lineAdvance - (ascent - descent) * size) / 2;
  const top = ascent * size + halfLeading;
  const bottom = -((Math.max(1, lineCount) - 1) * lineAdvance) + descent * size - halfLeading;
  return { top, bottom, lineAdvance };
}
