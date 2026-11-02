import type { FontFamily } from '../model/types';

/**
 * Matching the fonts named in a PDF against the fonts installed on this
 * computer. Pure functions, so the same logic serves the desktop app (font
 * list from Rust), the browser build (Local Font Access) and the tests.
 */

export interface InstalledFace {
  /** File path (desktop) or an opaque id (browser). */
  path: string;
  /** Face index inside a font collection (.ttc). */
  index: number;
  postscriptName: string;
  family: string;
  /** CSS weight, 100–900. */
  weight: number;
  italic: boolean;
  monospaced?: boolean;
}

/** What we know about the font of some existing text. */
export interface SourceFontInfo {
  /** BaseFont without the subset prefix, e.g. "Arial-BoldMT". */
  postscriptName: string;
  /** /FontFamily from the font descriptor, when present. */
  familyName?: string;
  weight: number;
  italic: boolean;
}

export const normalizeName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Removes subset tags: the standard "ABCDEF+" prefix, and the "-1234" suffix
 * pdf-lib appends to fonts it embeds (including the ones this app saves).
 */
export function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '').replace(/-\d{4}$/, '');
}

export function isBoldWeight(weight: number): boolean {
  return weight >= 600;
}

const WEIGHT_WORDS: [RegExp, number][] = [
  [/(hairline|thin)/, 100],
  [/(extra|ultra)light/, 200],
  [/light/, 300],
  [/(book|regular|normal|roman)/, 400],
  [/medium/, 500],
  [/(semi|demi)bold/, 600],
  [/(extra|ultra)bold/, 800],
  [/(black|heavy)/, 900],
  [/bold/, 700],
];

/** Weight implied by a style word in a font name ("Calibri-Light" → 300). */
export function weightFromName(name: string): number | undefined {
  const style = name.toLowerCase().split(/[-,]/).slice(1).join(' ');
  if (!style) return undefined;
  for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
  return undefined;
}

/** Family names a PostScript name might belong to ("TimesNewRomanPSMT" → "TimesNewRoman"). */
export function familyCandidates(source: Pick<SourceFontInfo, 'postscriptName' | 'familyName'>): string[] {
  const out: string[] = [];
  if (source.familyName) out.push(source.familyName);
  const base = stripSubsetTag(source.postscriptName).split(/[-,]/)[0];
  out.push(base);
  const trimmed = base.replace(/(PSMT|PS|MT)$/, '');
  if (trimmed && trimmed !== base) out.push(trimmed);
  return out;
}

/** The 14 standard PDF fonts, which every viewer provides without embedding. */
const STANDARD_14: Record<string, { family: FontFamily; bold: boolean; italic: boolean } | null> = {
  helvetica: { family: 'Helvetica', bold: false, italic: false },
  helveticabold: { family: 'Helvetica', bold: true, italic: false },
  helveticaoblique: { family: 'Helvetica', bold: false, italic: true },
  helveticaboldoblique: { family: 'Helvetica', bold: true, italic: true },
  timesroman: { family: 'Times', bold: false, italic: false },
  timesbold: { family: 'Times', bold: true, italic: false },
  timesitalic: { family: 'Times', bold: false, italic: true },
  timesbolditalic: { family: 'Times', bold: true, italic: true },
  courier: { family: 'Courier', bold: false, italic: false },
  courierbold: { family: 'Courier', bold: true, italic: false },
  courieroblique: { family: 'Courier', bold: false, italic: true },
  courierboldoblique: { family: 'Courier', bold: true, italic: true },
};

/** The standard family when `name` is one of the standard PDF fonts (exact names only). */
export function standardFontFor(name: string): { family: FontFamily; bold: boolean; italic: boolean } | null {
  return STANDARD_14[normalizeName(stripSubsetTag(name))] ?? null;
}

/**
 * Picks the face of a family closest to a weight and slant, following the
 * CSS font-matching rules (slant first, then weight).
 */
export function pickFace(faces: InstalledFace[], family: string, weight: number, italic: boolean): InstalledFace | null {
  const wanted = normalizeName(family);
  let candidates = faces.filter((f) => normalizeName(f.family) === wanted);
  if (!candidates.length) return null;
  const sameSlant = candidates.filter((f) => f.italic === italic);
  if (sameSlant.length) candidates = sameSlant;

  const rank = (w: number): number => {
    if (w === weight) return 0;
    if (weight >= 400 && weight <= 500) {
      if (w > weight && w <= 500) return w - weight; // up to 500 first
      if (w < weight) return 1000 + (weight - w); // then lighter
      return 2000 + (w - weight); // then heavier
    }
    if (weight < 400) return w < weight ? weight - w : 1000 + (w - weight);
    return w > weight ? w - weight : 1000 + (weight - w);
  };
  return candidates.reduce((best, f) => (rank(f.weight) < rank(best.weight) ? f : best));
}

/**
 * Installed faces that could stand in for a PDF font, best first: the exact
 * PostScript name, then the closest face of the same family.
 */
export function matchSourceFont(faces: InstalledFace[], source: SourceFontInfo): InstalledFace[] {
  const out: InstalledFace[] = [];
  const ps = normalizeName(stripSubsetTag(source.postscriptName));
  const exact = faces.find((f) => normalizeName(f.postscriptName) === ps);
  if (exact) out.push(exact);
  for (const family of familyCandidates(source)) {
    const face = pickFace(faces, family, source.weight, source.italic);
    if (face && !out.includes(face)) out.push(face);
  }
  return out;
}

/** The face to use for a style that names an installed font. */
export function faceForRef(
  faces: InstalledFace[],
  ref: { family: string; face?: string },
  bold: boolean,
  italic: boolean,
): InstalledFace | null {
  if (ref.face) {
    const exact = faces.find((f) => f.postscriptName === ref.face);
    if (exact && isBoldWeight(exact.weight) === bold && exact.italic === italic) return exact;
  }
  return pickFace(faces, ref.family, bold ? 700 : 400, italic);
}

/** Sorted, de-duplicated family names. */
export function familyNames(faces: InstalledFace[]): string[] {
  const seen = new Map<string, string>();
  for (const f of faces) {
    const key = normalizeName(f.family);
    if (!seen.has(key)) seen.set(key, f.family);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
