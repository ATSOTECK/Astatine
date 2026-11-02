import { PDFArray, PDFDict, PDFName, PDFPage, PDFStream, type PDFContext } from 'pdf-lib';
import { getFontInfo, type FontInfo } from './fonts';
import { parseContentStream, type CSObject, type CSOperation } from './lexer';
import { applyToPoint, IDENTITY, multiply, translation, type Matrix, type Point } from './matrix';
import {
  arrayItems,
  arrayNumbers,
  dictGet,
  getArray,
  getDict,
  getNumber,
  pageContentBytes,
  pageResources,
  resolve,
  streamBytes,
} from './objects';

/**
 * Interprets a page's content stream (and nested form XObjects) far enough to
 * know where every glyph is drawn, with which font, size and colour, and
 * which operation drew it. This is what lets us remove exactly the glyphs of
 * a line of existing text without disturbing anything else on the page.
 */

export type RGB = [number, number, number];

export type ShowElement =
  | { kind: 'glyph'; bytes: Uint8Array; code: number; width: number; wordSpace: boolean }
  | { kind: 'adjust'; value: number };

export interface TextShowOp {
  opIndex: number;
  op: 'Tj' | 'TJ' | "'" | '"';
  operands: CSObject[];
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  elements: ShowElement[];
}

export interface ContentContainer {
  bytes: Uint8Array;
  ops: CSOperation[];
  /** Resources used to interpret this container. */
  resources: PDFDict | undefined;
  /** The form XObject stream (absent for the page itself). */
  stream?: PDFStream;
  /** Nested form XObjects, keyed by the index of the `Do` that paints them. */
  children: Map<number, ContentContainer>;
  textOps: Map<number, TextShowOp>;
}

export interface Glyph {
  container: ContentContainer;
  show: TextShowOp;
  /** Index among the glyph elements of `show`. */
  glyphIndex: number;
  /** Centre of the glyph box in page user space. */
  center: Point;
  /** Baseline origin of the glyph in page user space. */
  origin: Point;
  /** Baseline direction in degrees (counter-clockwise, user space). */
  angle: number;
  /** Effective font size in user space units. */
  size: number;
  /** Advance along the baseline in user space units (without character spacing). */
  advance: number;
  /** Horizontal ÷ vertical glyph scale (Tz and non-uniform matrices); 1 = normal. */
  hScale: number;
  /** Character spacing (Tc) along the baseline, in user space units. */
  charSpacing: number;
  font: FontInfo;
  color: RGB;
  renderMode: number;
}

export interface PageInterpretation {
  root: ContentContainer;
  glyphs: Glyph[];
}

type ColorSpace = 'gray' | 'rgb' | 'cmyk' | 'other';

interface GraphicsState {
  ctm: Matrix;
  fillSpace: ColorSpace;
  fill: RGB;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  leading: number;
  font: FontInfo | null;
  fontSize: number;
  renderMode: number;
  rise: number;
}

const MAX_DEPTH = 12;

export function interpretPage(page: PDFPage): PageInterpretation {
  const context = page.node.context;
  const bytes = pageContentBytes(page);
  const root: ContentContainer = {
    bytes,
    ops: parseContentStream(bytes),
    resources: pageResources(page),
    children: new Map(),
    textOps: new Map(),
  };
  const glyphs: Glyph[] = [];
  const state: GraphicsState = {
    ctm: [...IDENTITY],
    fillSpace: 'gray',
    fill: [0, 0, 0],
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScale: 1,
    leading: 0,
    font: null,
    fontSize: 0,
    renderMode: 0,
    rise: 0,
  };
  run(context, root, state, glyphs, 0, new Set());
  return { root, glyphs };
}

function toRGB(space: ColorSpace, values: number[]): RGB {
  const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  switch (space) {
    case 'gray':
      return [clamp(values[0]), clamp(values[0]), clamp(values[0])];
    case 'rgb':
      return [clamp(values[0]), clamp(values[1]), clamp(values[2])];
    case 'cmyk': {
      const [c, m, y, k] = values.map(clamp);
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    }
    default:
      return [0, 0, 0];
  }
}

function resolveColorSpace(context: PDFContext, resources: PDFDict | undefined, name: string): ColorSpace {
  switch (name) {
    case 'DeviceGray':
    case 'G':
    case 'CalGray':
      return 'gray';
    case 'DeviceRGB':
    case 'RGB':
    case 'CalRGB':
      return 'rgb';
    case 'DeviceCMYK':
    case 'CMYK':
      return 'cmyk';
    case 'Pattern':
      return 'other';
  }
  const cs = dictGet(getDict(resources, 'ColorSpace'), name);
  if (cs instanceof PDFName) return resolveColorSpace(context, undefined, cs.decodeText());
  if (cs instanceof PDFArray) {
    const items = arrayItems(context, cs);
    const family = items[0] instanceof PDFName ? items[0].decodeText() : '';
    if (family === 'ICCBased') {
      const stream = items[1];
      const n = stream instanceof PDFStream ? getNumber(stream.dict, 'N') : undefined;
      return n === 1 ? 'gray' : n === 4 ? 'cmyk' : n === 3 ? 'rgb' : 'other';
    }
    if (family === 'CalRGB') return 'rgb';
    if (family === 'CalGray') return 'gray';
  }
  return 'other';
}

function numbers(operands: CSObject[]): number[] {
  return operands.filter((o) => o.type === 'number').map((o) => (o as { value: number }).value);
}

function run(
  context: PDFContext,
  container: ContentContainer,
  initial: GraphicsState,
  glyphs: Glyph[],
  depth: number,
  ancestors: Set<PDFStream>,
) {
  const stack: GraphicsState[] = [];
  let gs: GraphicsState = { ...initial, fill: [...initial.fill] as RGB };
  let tm: Matrix = [...IDENTITY];
  let tlm: Matrix = [...IDENTITY];
  const fonts = getDict(container.resources, 'Font');

  const show = (opIndex: number, op: TextShowOp['op'], operands: CSObject[], parts: CSObject[]) => {
    const font = gs.font ?? getFontInfo(context, undefined);
    const record: TextShowOp = {
      opIndex,
      op,
      operands,
      fontSize: gs.fontSize,
      charSpacing: gs.charSpacing,
      wordSpacing: gs.wordSpacing,
      horizontalScale: gs.horizontalScale,
      elements: [],
    };
    container.textOps.set(opIndex, record);
    let glyphIndex = 0;
    const th = gs.horizontalScale;
    const tfs = gs.fontSize;
    for (const part of parts) {
      if (part.type === 'number') {
        record.elements.push({ kind: 'adjust', value: part.value });
        tm = multiply(translation((-part.value / 1000) * tfs * th, 0), tm);
        continue;
      }
      if (part.type !== 'string') continue;
      for (const [start, end, code] of font.split(part.bytes)) {
        const length = end - start;
        const width = font.width(code, length);
        const wordSpace = font.isWordSpace(code, length);
        record.elements.push({ kind: 'glyph', bytes: part.bytes.slice(start, end), code, width, wordSpace });

        const trm = multiply([tfs * th, 0, 0, tfs, 0, gs.rise], multiply(tm, gs.ctm));
        const m = multiply(tm, gs.ctm);
        const xScale = Math.hypot(m[0], m[1]);
        const yScale = Math.hypot(m[2], m[3]);
        const origin = applyToPoint(trm, 0, 0);
        const end2 = applyToPoint(trm, width, 0);
        glyphs.push({
          container,
          show: record,
          glyphIndex: glyphIndex++,
          center: applyToPoint(trm, width / 2, (font.ascent + font.descent) / 2),
          origin,
          angle: (Math.atan2(trm[1], trm[0]) * 180) / Math.PI,
          size: Math.abs(tfs) * yScale,
          advance: Math.hypot(end2[0] - origin[0], end2[1] - origin[1]),
          hScale: yScale > 0 ? (th * xScale) / yScale : 1,
          charSpacing: gs.charSpacing * th * xScale,
          font,
          color: [...gs.fill] as RGB,
          renderMode: gs.renderMode,
        });

        const tx = (width * tfs + gs.charSpacing + (wordSpace ? gs.wordSpacing : 0)) * th;
        tm = multiply(translation(tx, 0), tm);
      }
    }
  };

  const nextLine = () => {
    tlm = multiply(translation(0, -gs.leading), tlm);
    tm = [...tlm];
  };

  container.ops.forEach((operation, opIndex) => {
    const { op, operands } = operation;
    const n = numbers(operands);
    switch (op) {
      case 'q':
        stack.push({ ...gs, fill: [...gs.fill] as RGB });
        break;
      case 'Q':
        if (stack.length) gs = stack.pop()!;
        break;
      case 'cm':
        if (n.length >= 6) gs.ctm = multiply(n.slice(0, 6) as Matrix, gs.ctm);
        break;
      case 'g':
        gs.fillSpace = 'gray';
        gs.fill = toRGB('gray', n);
        break;
      case 'rg':
        gs.fillSpace = 'rgb';
        gs.fill = toRGB('rgb', n);
        break;
      case 'k':
        gs.fillSpace = 'cmyk';
        gs.fill = toRGB('cmyk', n);
        break;
      case 'cs': {
        const name = operands[0]?.type === 'name' ? operands[0].value : '';
        gs.fillSpace = resolveColorSpace(context, container.resources, name);
        gs.fill = [0, 0, 0]; // every colour space starts out black
        break;
      }
      case 'sc':
      case 'scn':
        gs.fill = toRGB(gs.fillSpace, n);
        break;
      case 'BT':
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        break;
      case 'Tc':
        gs.charSpacing = n[0] ?? 0;
        break;
      case 'Tw':
        gs.wordSpacing = n[0] ?? 0;
        break;
      case 'Tz':
        gs.horizontalScale = (n[0] ?? 100) / 100;
        break;
      case 'TL':
        gs.leading = n[0] ?? 0;
        break;
      case 'Ts':
        gs.rise = n[0] ?? 0;
        break;
      case 'Tr':
        gs.renderMode = n[0] ?? 0;
        break;
      case 'Tf': {
        const name = operands[0]?.type === 'name' ? operands[0].value : '';
        const fontObj = dictGet(fonts, name);
        gs.font = getFontInfo(context, fontObj instanceof PDFDict ? fontObj : undefined);
        gs.fontSize = n[0] ?? 0;
        break;
      }
      case 'Td':
        tlm = multiply(translation(n[0] ?? 0, n[1] ?? 0), tlm);
        tm = [...tlm];
        break;
      case 'TD':
        gs.leading = -(n[1] ?? 0);
        tlm = multiply(translation(n[0] ?? 0, n[1] ?? 0), tlm);
        tm = [...tlm];
        break;
      case 'Tm':
        if (n.length >= 6) {
          tlm = n.slice(0, 6) as Matrix;
          tm = [...tlm];
        }
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tj':
        show(opIndex, 'Tj', operands, operands.slice(0, 1));
        break;
      case 'TJ': {
        const arr = operands[0];
        show(opIndex, 'TJ', operands, arr?.type === 'array' ? arr.items : []);
        break;
      }
      case "'":
        nextLine();
        show(opIndex, "'", operands, operands.slice(-1));
        break;
      case '"':
        gs.wordSpacing = n[0] ?? gs.wordSpacing;
        gs.charSpacing = n[1] ?? gs.charSpacing;
        nextLine();
        show(opIndex, '"', operands, operands.slice(-1));
        break;
      case 'Do': {
        if (depth >= MAX_DEPTH) break;
        const name = operands[0]?.type === 'name' ? operands[0].value : '';
        const xobjects = getDict(container.resources, 'XObject');
        const xobj = resolve(context, xobjects?.get(PDFName.of(name)));
        if (!(xobj instanceof PDFStream)) break;
        if (dictGet(xobj.dict, 'Subtype')?.toString() !== '/Form') break;
        if (ancestors.has(xobj)) break;
        const bytes = streamBytes(xobj);
        if (!bytes) break;
        const matrix = arrayNumbers(context, getArray(xobj.dict, 'Matrix'));
        const ownResources = getDict(xobj.dict, 'Resources');
        const child: ContentContainer = {
          bytes,
          ops: parseContentStream(bytes),
          resources: ownResources ?? container.resources,
          stream: xobj,
          children: new Map(),
          textOps: new Map(),
        };
        container.children.set(opIndex, child);
        const childState: GraphicsState = {
          ...gs,
          fill: [...gs.fill] as RGB,
          ctm: matrix.length === 6 ? multiply(matrix as Matrix, gs.ctm) : [...gs.ctm],
        };
        ancestors.add(xobj);
        run(context, child, childState, glyphs, depth + 1, ancestors);
        ancestors.delete(xobj);
        break;
      }
    }
  });
}
