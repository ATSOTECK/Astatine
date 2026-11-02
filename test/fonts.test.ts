import { existsSync, readFileSync } from 'node:fs';
import fontkit from '@pdf-lib/fontkit';
import { describe, expect, test } from 'vitest';
import {
  faceForRef,
  familyCandidates,
  familyNames,
  matchSourceFont,
  pickFace,
  standardFontFor,
  weightFromName,
  type InstalledFace,
} from '../src/pdf/fontMatch';
import { collectionSize, extractFace, isCollection } from '../src/pdf/sfnt';

const face = (postscriptName: string, family: string, weight = 400, italic = false): InstalledFace => ({
  path: `/fonts/${postscriptName}.ttf`,
  index: 0,
  postscriptName,
  family,
  weight,
  italic,
});

const FACES: InstalledFace[] = [
  face('ArialMT', 'Arial'),
  face('Arial-BoldMT', 'Arial', 700),
  face('Arial-ItalicMT', 'Arial', 400, true),
  face('Arial-BoldItalicMT', 'Arial', 700, true),
  face('TimesNewRomanPSMT', 'Times New Roman'),
  face('TimesNewRomanPS-BoldMT', 'Times New Roman', 700),
  face('HelveticaNeue', 'Helvetica Neue'),
  face('HelveticaNeue-Light', 'Helvetica Neue', 300),
  face('HelveticaNeue-Medium', 'Helvetica Neue', 500),
  face('HelveticaNeue-Bold', 'Helvetica Neue', 700),
  face('Menlo-Regular', 'Menlo'),
];

describe('matching PDF fonts to installed fonts', () => {
  test('exact PostScript name wins', () => {
    const [best] = matchSourceFont(FACES, { postscriptName: 'Arial-BoldMT', weight: 700, italic: false });
    expect(best.postscriptName).toBe('Arial-BoldMT');
  });

  test('subset prefixes and "Name,Style" names resolve through the family', () => {
    expect(matchSourceFont(FACES, { postscriptName: 'ABCDEF+Arial,BoldItalic', weight: 700, italic: true })[0].postscriptName).toBe(
      'Arial-BoldItalicMT',
    );
    expect(matchSourceFont(FACES, { postscriptName: 'TimesNewRomanPSMT', weight: 400, italic: false })[0].family).toBe(
      'Times New Roman',
    );
  });

  test('weights such as Light are kept', () => {
    const source = { postscriptName: 'XYZABC+HelveticaNeue-LightCond', weight: weightFromName('HelveticaNeue-Light')!, italic: false };
    expect(matchSourceFont(FACES, source)[0].postscriptName).toBe('HelveticaNeue-Light');
  });

  test('descriptor family names are used', () => {
    const [best] = matchSourceFont(FACES, { postscriptName: 'F1', familyName: 'Menlo', weight: 400, italic: false });
    expect(best.postscriptName).toBe('Menlo-Regular');
  });

  test('fonts this app embedded (pdf-lib subset suffix) map back to the exact face', () => {
    const [best] = matchSourceFont(FACES, { postscriptName: 'HelveticaNeue-Light-4821', weight: 300, italic: false });
    expect(best.postscriptName).toBe('HelveticaNeue-Light');
  });

  test('fonts that are not installed give no match', () => {
    expect(matchSourceFont(FACES, { postscriptName: 'Calibri-Bold', weight: 700, italic: false })).toEqual([]);
  });

  test('CSS-style face selection within a family', () => {
    expect(pickFace(FACES, 'Helvetica Neue', 600, false)!.weight).toBe(700);
    expect(pickFace(FACES, 'Helvetica Neue', 400, false)!.weight).toBe(400);
    expect(pickFace(FACES, 'helveticaneue', 200, false)!.weight).toBe(300);
    expect(pickFace(FACES, 'Times New Roman', 400, true)!.italic).toBe(false); // no italic face: closest upright
  });

  test('styles pick the exact face, or re-pick when bold/italic changed', () => {
    const light = { family: 'Helvetica Neue', face: 'HelveticaNeue-Light' };
    expect(faceForRef(FACES, light, false, false)!.postscriptName).toBe('HelveticaNeue-Light');
    expect(faceForRef(FACES, light, true, false)!.postscriptName).toBe('HelveticaNeue-Bold');
  });

  test('standard PDF fonts are recognised by exact name only', () => {
    expect(standardFontFor('Helvetica-BoldOblique')).toEqual({ family: 'Helvetica', bold: true, italic: true });
    expect(standardFontFor('Times-Roman')!.family).toBe('Times');
    expect(standardFontFor('ArialMT')).toBeNull();
    expect(standardFontFor('TimesNewRomanPSMT')).toBeNull();
  });

  test('helpers', () => {
    expect(familyCandidates({ postscriptName: 'ABCDEF+CourierNewPSMT' })).toEqual(['CourierNewPSMT', 'CourierNew']);
    expect(weightFromName('Calibri-Semibold')).toBe(600);
    expect(weightFromName('Calibri')).toBeUndefined();
    expect(familyNames(FACES)).toEqual(['Arial', 'Helvetica Neue', 'Menlo', 'Times New Roman']);
  });
});

const HELVETICA_TTC = '/System/Library/Fonts/Helvetica.ttc';

describe.skipIf(!existsSync(HELVETICA_TTC))('font collections (macOS)', () => {
  test('every face extracts to a standalone font that parses and has glyphs', () => {
    const ttc = new Uint8Array(readFileSync(HELVETICA_TTC));
    expect(isCollection(ttc)).toBe(true);
    const names = new Set<string>();
    for (let i = 0; i < collectionSize(ttc); i++) {
      const single = extractFace(ttc, i);
      expect(isCollection(single)).toBe(false);
      const font = fontkit.create(single);
      expect(font.hasGlyphForCodePoint('A'.codePointAt(0)!)).toBe(true);
      names.add(font.postscriptName!);
    }
    expect(names.has('Helvetica-Bold')).toBe(true);
    expect(names.size).toBe(collectionSize(ttc));
  });
});
