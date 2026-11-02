import { Lexer, type Token } from './lexer';

/**
 * Minimal CMap support for composite (Type0) fonts: enough to split a byte
 * string into character codes and to map codes to CIDs for width lookup.
 */

export interface CodespaceRange {
  length: number;
  low: number[];
  high: number[];
}

export interface CMap {
  codespace: CodespaceRange[];
  /** Maps a character code to a CID. */
  toCid(code: number, length: number): number;
}

interface CidRange {
  length: number;
  low: number;
  high: number;
  cid: number;
}

function bytesToInt(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

export const IDENTITY_CMAP: CMap = {
  codespace: [{ length: 2, low: [0, 0], high: [0xff, 0xff] }],
  toCid: (code) => code,
};

/** One-byte codes with an identity CID mapping (fallback for unknown CMaps). */
export const ONE_BYTE_CMAP: CMap = {
  codespace: [{ length: 1, low: [0], high: [0xff] }],
  toCid: (code) => code,
};

export function parseCMap(bytes: Uint8Array): CMap {
  const lexer = new Lexer(bytes);
  const tokens: Token[] = [];
  for (let t = lexer.next(); t; t = lexer.next()) tokens.push(t);

  const codespace: CodespaceRange[] = [];
  const ranges: CidRange[] = [];
  const singles = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'keyword') continue;
    if (t.value === 'begincodespacerange') {
      for (i++; i + 1 < tokens.length; i += 2) {
        const lo = tokens[i];
        const hi = tokens[i + 1];
        if (lo.type !== 'string' || hi.type !== 'string') break;
        codespace.push({ length: lo.bytes.length, low: [...lo.bytes], high: [...hi.bytes] });
      }
    } else if (t.value === 'begincidrange') {
      for (i++; i + 2 < tokens.length; i += 3) {
        const lo = tokens[i];
        const hi = tokens[i + 1];
        const cid = tokens[i + 2];
        if (lo.type !== 'string' || hi.type !== 'string' || cid.type !== 'number') break;
        ranges.push({ length: lo.bytes.length, low: bytesToInt(lo.bytes), high: bytesToInt(hi.bytes), cid: cid.value });
      }
    } else if (t.value === 'begincidchar') {
      for (i++; i + 1 < tokens.length; i += 2) {
        const code = tokens[i];
        const cid = tokens[i + 1];
        if (code.type !== 'string' || cid.type !== 'number') break;
        singles.set(`${code.bytes.length}:${bytesToInt(code.bytes)}`, cid.value);
      }
    }
  }

  if (codespace.length === 0) codespace.push(...IDENTITY_CMAP.codespace);
  const identity = ranges.length === 0 && singles.size === 0;

  return {
    codespace,
    toCid(code: number, length: number): number {
      if (identity) return code;
      const single = singles.get(`${length}:${code}`);
      if (single !== undefined) return single;
      for (const r of ranges) {
        if (r.length === length && code >= r.low && code <= r.high) return r.cid + (code - r.low);
      }
      return 0;
    },
  };
}

/**
 * Splits a byte string into character codes according to codespace ranges.
 * Returns [start, end, code] triples.
 */
export function splitCodes(bytes: Uint8Array, codespace: CodespaceRange[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  const minLength = Math.min(...codespace.map((r) => r.length));
  let i = 0;
  while (i < bytes.length) {
    let matched = 0;
    for (let len = 1; len <= 4 && i + len <= bytes.length && !matched; len++) {
      for (const r of codespace) {
        if (r.length !== len) continue;
        let ok = true;
        for (let k = 0; k < len; k++) {
          const b = bytes[i + k];
          if (b < r.low[k] || b > r.high[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          matched = len;
          break;
        }
      }
    }
    const len = matched || Math.min(minLength, bytes.length - i);
    out.push([i, i + len, bytesToInt(bytes.subarray(i, i + len))]);
    i += len;
  }
  return out;
}
