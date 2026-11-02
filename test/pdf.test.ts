import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, test } from 'vitest';
import type { TextObject } from '../src/model/types';
import { parseContentStream, spliceOperations } from '../src/pdf/lexer';
import { streamBytes } from '../src/pdf/objects';
import { convertItem, exportDocument, openDocument, type FontBytesProvider } from '../src/pdf/session';
import { fixture, openWithPdfjs, textItems, type SimpleItem } from './helpers';

const fonts: FontBytesProvider = {
  async unicodeFont(bold, italic) {
    const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
    return new Uint8Array(readFileSync(resolve(`node_modules/pdfjs-dist/standard_fonts/LiberationSans-${style}.ttf`)));
  },
};

let nextId = 0;
const newId = () => `t${++nextId}`;

const enc = new TextEncoder();

describe('content stream lexer', () => {
  test('round-trips untouched bytes exactly', () => {
    const src = enc.encode('q 1 0 0 1 10 20 cm BT /F1 12 Tf (Hello \\(world\\)) Tj [(A) -120 <0041>] TJ ET Q % comment\n');
    const ops = parseContentStream(src);
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'Q']);
    expect(spliceOperations(src, ops, new Map())).toEqual(src);
    const tj = ops[4].operands[0];
    expect(tj.type === 'string' && new TextDecoder().decode(tj.bytes)).toBe('Hello (world)');
  });

  test('skips inline image data, even when it contains operator-like bytes', () => {
    const src = new Uint8Array([
      ...enc.encode('q BI /W 2 /H 2 /CS /G /BPC 8 ID '),
      0x00, 0x45, 0x49, 0xff, // "EI" inside binary data
      ...enc.encode(' EI Q BT ET'),
    ]);
    expect(parseContentStream(src).map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'BT', 'ET']);
  });

  test('replaces only the targeted operation', () => {
    const src = enc.encode('BT (a) Tj (b) Tj ET');
    const ops = parseContentStream(src);
    const out = new TextDecoder().decode(spliceOperations(src, ops, new Map([[2, '[(x)] TJ']])));
    expect(out).toBe('BT (a) Tj  [(x)] TJ\n ET');
  });
});

function sameSpot(a: SimpleItem, b: SimpleItem): boolean {
  return Math.abs(a.transform[4] - b.transform[4]) < 0.05 && Math.abs(a.transform[5] - b.transform[5]) < 0.05;
}

async function convertAndCheck(name: string, pick: (items: SimpleItem[]) => SimpleItem, pageIndex = 0) {
  const bytes = fixture(name);
  const before = await textItems(bytes, pageIndex);
  const target = pick(before);
  const opened = await openDocument(bytes, newId);
  const converted = await convertItem(opened.doc, pageIndex, target, newId());
  expect(converted, `conversion of "${target.str}" in ${name}`).not.toBeNull();
  const after = await textItems(converted!.bytes, pageIndex);

  // The target is gone…
  expect(after.some((i) => i.str === target.str && sameSpot(i, target))).toBe(false);
  // …and every other line is still there, exactly where it was.
  for (const item of before) {
    if (item === target) continue;
    if (item.str.trim() === '' || sameSpot(item, target)) continue;
    const match = after.find((i) => i.str.trim() === item.str.trim() && sameSpot(i, item));
    expect(match, `"${item.str}" should be untouched in ${name}`).toBeDefined();
  }
  return { opened, converted: converted!, target, before };
}

describe('editing existing page text', () => {
  test('pdf-lib output (standard fonts without /Widths)', async () => {
    const { converted } = await convertAndCheck('pdflib.pdf', (items) => items.find((i) => i.str.startsWith('Hello'))!);
    const obj = converted.result.object;
    expect(obj.text).toBe('Hello World from pdf-lib');
    expect(obj.style).toMatchObject({ family: 'Helvetica', bold: false, size: 18 });
    expect(obj.style.color[0]).toBeCloseTo(0.8, 2);
    expect([obj.x, obj.y]).toEqual([72, 700]);
  });

  test('rotated text keeps its angle', async () => {
    const { converted } = await convertAndCheck('pdflib.pdf', (items) => items.find((i) => i.str === 'Rotated text')!);
    expect(converted.result.object.angle).toBeCloseTo(30, 3);
  });

  test('Chrome output (Type0 / Identity-H fonts), middle of a line', async () => {
    const { converted } = await convertAndCheck('chrome.pdf', (items) => items.find((i) => i.str === 'Bold words')!);
    expect(converted.result.object.style).toMatchObject({ family: 'Helvetica', bold: true });
    // The original font is reported for matching against installed fonts.
    expect(converted.result.sourceFont).toMatchObject({ postscriptName: 'Arial-BoldMT', weight: 700, italic: false });
  });

  test('Chrome output, coloured serif paragraph', async () => {
    const { converted } = await convertAndCheck('chrome.pdf', (items) => items.find((i) => i.str.startsWith('Serif'))!);
    const { style } = converted.result.object;
    expect(style.family).toBe('Times');
    expect(style.color[2]).toBeGreaterThan(0.6);
  });

  test('Chrome output, text rotated by CSS', async () => {
    const { converted } = await convertAndCheck('chrome.pdf', (items) => items.find((i) => i.str === 'Sideways text')!);
    expect(Math.abs(converted.result.object.angle)).toBeCloseTo(90, 1);
  });

  test('LibreOffice output (TrueType subsets)', async () => {
    const { converted } = await convertAndCheck('libreoffice.pdf', (items) => items.find((i) => i.str.startsWith('Total'))!);
    expect(converted.result.object.style.family).toBe('Times');
  });

  test("hand-written stream with TJ kerning, ' and \" operators", async () => {
    for (const str of ['Kerned TJ', 'Apostrophe line', 'Quote']) {
      await convertAndCheck('handwritten.pdf', (items) => items.find((i) => i.str === str)!);
    }
  });

  test('letter-spaced text is edited without the spaces pdf.js inserts', async () => {
    const { converted } = await convertAndCheck('handwritten.pdf', (items) => items.find((i) => i.str === 'S p a c e d')!);
    expect(converted.result.object.text).toBe('Spaced');
  });

  test('pages with /Rotate keep their geometry', async () => {
    const { converted } = await convertAndCheck('rotated.pdf', (items) => items.find((i) => i.str.startsWith('Upright'))!);
    const obj = converted.result.object;
    expect(obj.angle).toBeCloseTo(90, 3);
    expect(obj.x).toBeCloseTo(100, 3);
    expect(obj.y).toBeCloseTo(100, 3);
  });

  test('condensed, stretched and tracked text keeps its proportions', async () => {
    const cases: [string, Partial<TextObject>][] = [
      ['Condensed to eighty percent', { hScale: 0.8 }],
      ['Matrix wider than tall', { hScale: 1.333 }],
      ['Tracked out letters', { charSpacing: 1.5 }],
      ['Tightly tracked letters', { charSpacing: -0.4 }],
    ];
    for (const [str, expected] of cases) {
      const target = (await textItems(fixture('scaled.pdf'))).find((i) => i.str.replace(/ /g, '') === str.replace(/ /g, ''))!;
      const { converted } = await convertAndCheck('scaled.pdf', (items) => items.find((i) => i.str === target.str)!);
      const obj = converted.result.object;
      expect(obj.text).toBe(str); // tracked text without the spaces pdf.js inserts
      expect(obj.hScale ?? 1).toBeCloseTo(expected.hScale ?? 1, 3);
      expect(obj.charSpacing ?? 0).toBeCloseTo(expected.charSpacing ?? 0, 3);

      // Saved unchanged, the replacement takes exactly the original's width.
      const out = await exportDocument(converted.bytes, [obj], [], [], { flatten: false }, fonts);
      const redrawn = (await textItems(out)).find((i) => i.str.replace(/ /g, '') === str.replace(/ /g, ''))!;
      expect(redrawn.transform[4]).toBeCloseTo(target.transform[4], 1);
      expect(redrawn.width).toBeCloseTo(target.width, 0);
    }
  });

  test('text inside a form XObject: only the clicked instance changes', async () => {
    const bytes = fixture('pdflib.pdf');
    const before = await textItems(bytes, 1);
    expect(before.filter((i) => i.str === 'Inside a form XObject')).toHaveLength(2);
    const top = before.reduce((a, b) => (a.transform[5] > b.transform[5] ? a : b));
    const opened = await openDocument(bytes, newId);
    const converted = await convertItem(opened.doc, 1, top, newId());
    expect(converted).not.toBeNull();
    const after = await textItems(converted!.bytes, 1);
    expect(after).toHaveLength(1);
    expect(after[0].transform[5]).toBeLessThan(top.transform[5]);
  });

  test('exported file contains the edit and not the original text', async () => {
    const { opened, converted, target } = await convertAndCheck('pdflib.pdf', (items) =>
      items.find((i) => i.str.startsWith('Hello'))!,
    );
    const edited: TextObject = { ...converted.result.object, text: 'Goodbye edited text' };
    const out = await exportDocument(converted.bytes, [...opened.objects, edited], opened.originals, opened.hiddenKeys, { flatten: false }, fonts);
    const items = await textItems(out);
    const replaced = items.find((i) => i.str === 'Goodbye edited text');
    expect(replaced).toBeDefined();
    expect(replaced!.transform[4]).toBeCloseTo(target.transform[4], 1);
    expect(replaced!.transform[5]).toBeCloseTo(target.transform[5], 1);
    expect(items.some((i) => i.str.includes('Hello World'))).toBe(false);

    // The old content stream must not survive as an orphaned object.
    const doc = await PDFDocument.load(out);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const data = streamBytes(obj);
      if (data) expect(new TextDecoder('latin1').decode(data)).not.toContain('Hello World');
    }
  });
});

describe('FreeText annotations from other programs', () => {
  test('are read with their text and style', async () => {
    const opened = await openDocument(fixture('freetext.pdf'), newId);
    expect(opened.originals).toHaveLength(2);
    const [preview, acrobat] = opened.objects;
    expect(preview).toMatchObject({ kind: 'annotation', text: 'Added in Preview', annotKey: '0:0' });
    expect(preview.style).toMatchObject({ family: 'Helvetica', size: 14, color: [1, 0, 0] });
    expect(acrobat.style).toMatchObject({ family: 'Times', size: 12 });
    expect(acrobat.style.color[2]).toBe(1);
    expect(acrobat.wrapWidth).not.toBeNull();
    // The one without an appearance stream is hidden in the working copy (we draw it).
    expect(opened.hiddenKeys).toEqual(['0:1']);
  });

  test('unchanged annotations are written back untouched', async () => {
    const bytes = fixture('freetext.pdf');
    const opened = await openDocument(bytes, newId);
    const out = await exportDocument(opened.workingBytes, opened.objects, opened.originals, opened.hiddenKeys, { flatten: false }, fonts);
    const task = openWithPdfjs(out);
    const annots = await (await (await task.promise).getPage(1)).getAnnotations();
    expect(annots.map((a) => a.contentsObj?.str)).toEqual(['Added in Preview', 'A longer note that wraps across several lines']);
    await task.destroy();
    const doc = await PDFDocument.load(out);
    const annot = doc.getPage(0).node.Annots()!;
    expect(annot.size()).toBe(2);
  });

  test('edits, deletes and additions are saved', async () => {
    const opened = await openDocument(fixture('freetext.pdf'), newId);
    const [preview] = opened.objects;
    const edited = { ...preview, text: 'Edited here\nwith two lines', style: { ...preview.style, bold: true } };
    const added: TextObject = {
      ...preview,
      id: newId(),
      annotKey: undefined,
      text: 'Brand new note',
      x: 300,
      y: 200,
      wrapWidth: null,
    };
    const out = await exportDocument(opened.workingBytes, [edited, added], opened.originals, opened.hiddenKeys, { flatten: false }, fonts);

    const task = openWithPdfjs(out);
    const page = await (await task.promise).getPage(1);
    const annots = await page.getAnnotations();
    await task.destroy();
    expect(annots.map((a) => a.contentsObj?.str.replace(/\r/g, '\n'))).toEqual(['Edited here\nwith two lines', 'Brand new note']);
    expect(annots.every((a) => a.hasAppearance)).toBe(true);

    // Reading our own output back gives the same objects (lossless round trip).
    const reopened = await openDocument(out, newId);
    const [r1, r2] = reopened.objects;
    expect(r1.text).toBe('Edited here\nwith two lines');
    expect(r1.style.bold).toBe(true);
    expect(r1.x).toBeCloseTo(edited.x, 2);
    expect(r1.y).toBeCloseTo(edited.y, 2);
    expect(r2.x).toBeCloseTo(300, 2);
    expect(r2.y).toBeCloseTo(200, 2);
    expect(r2.wrapWidth).toBeNull();
  });

  test('flattening writes text into the page', async () => {
    const opened = await openDocument(fixture('freetext.pdf'), newId);
    const out = await exportDocument(opened.workingBytes, opened.objects, opened.originals, opened.hiddenKeys, { flatten: true }, fonts);
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    const text = (await textItems(out)).map((i) => i.str).join(' ');
    expect(text).toContain('Added in Preview');
    expect(text).toContain('A longer note');
  });
});

describe('text the standard fonts cannot encode', () => {
  test('is written with an embedded Unicode font', async () => {
    const opened = await openDocument(fixture('pdflib.pdf'), newId);
    const obj: TextObject = {
      id: newId(),
      pageIndex: 0,
      kind: 'content',
      text: 'Zażółć gęślą jaźń — Привет',
      x: 72,
      y: 400,
      angle: 0,
      style: { family: 'Helvetica', bold: false, italic: false, size: 12, color: [0, 0, 0] },
      lineHeight: 1.2,
      wrapWidth: null,
      background: null,
    };
    const out = await exportDocument(opened.workingBytes, [obj], [], [], { flatten: false }, fonts);
    const text = (await textItems(out)).map((i) => i.str).join('');
    expect(text).toContain('Zażółć gęślą jaźń — Привет');
  });
});

describe('installed fonts', () => {
  // Liberation Sans stands in for "a font installed on this computer".
  const installed: FontBytesProvider = {
    ...fonts,
    async installedFont(ref, bold, italic) {
      if (ref.family !== 'Liberation Sans') return null;
      return { key: `LiberationSans-${bold}-${italic}`, bytes: await fonts.unicodeFont(bold, italic) };
    },
  };
  const base: TextObject = {
    id: 'x',
    pageIndex: 0,
    kind: 'content',
    text: 'Matched font text',
    x: 72,
    y: 300,
    angle: 0,
    style: { family: 'Helvetica', font: { family: 'Liberation Sans' }, bold: true, italic: false, size: 14, color: [0, 0, 0] },
    lineHeight: 1.2,
    wrapWidth: null,
    background: null,
  };

  async function fontNames(bytes: Uint8Array): Promise<string[]> {
    const doc = await PDFDocument.load(bytes);
    const names: string[] = [];
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      const dict = obj instanceof PDFDict ? obj : undefined;
      if (dict?.get(PDFName.of('Type'))?.toString() === '/Font') names.push(String(dict.get(PDFName.of('BaseFont'))));
    }
    return names;
  }

  test('are embedded when saving page text', async () => {
    const opened = await openDocument(fixture('pdflib.pdf'), newId);
    const out = await exportDocument(opened.workingBytes, [base], [], [], { flatten: false }, installed);
    expect((await textItems(out)).some((i) => i.str === 'Matched font text')).toBe(true);
    expect((await fontNames(out)).some((n) => /^\/LiberationSans-Bold-\d+$/.test(n))).toBe(true);
  });

  test('fall back to the standard family when not available', async () => {
    const opened = await openDocument(fixture('pdflib.pdf'), newId);
    const missing = { ...base, style: { ...base.style, font: { family: 'Not A Real Font' } } };
    const out = await exportDocument(opened.workingBytes, [missing], [], [], { flatten: false }, installed);
    expect(await fontNames(out)).toContain('/Helvetica-Bold');
  });

  test('round-trip through FreeText annotations', async () => {
    const opened = await openDocument(fixture('pdflib.pdf'), newId);
    const note: TextObject = { ...base, kind: 'annotation', text: 'Note in an installed font' };
    const out = await exportDocument(opened.workingBytes, [note], [], [], { flatten: false }, installed);
    const reopened = await openDocument(out, newId);
    expect(reopened.objects[0].style.font).toEqual({ family: 'Liberation Sans' });
    expect(reopened.objects[0].style.bold).toBe(true);
    expect(reopened.objects[0].x).toBeCloseTo(72, 2);
    expect(reopened.objects[0].y).toBeCloseTo(300, 2);
  });
});
