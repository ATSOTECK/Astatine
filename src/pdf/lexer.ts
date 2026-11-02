/**
 * A tolerant lexer/parser for PDF content streams (and CMap programs, which
 * share the same token syntax). Operations keep their byte ranges so a stream
 * can be rewritten by splicing new bytes over individual operations while the
 * rest of the stream stays byte-for-byte identical.
 */

export type CSObject =
  | { type: 'number'; value: number }
  | { type: 'string'; bytes: Uint8Array }
  | { type: 'name'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'array'; items: CSObject[] }
  | { type: 'dict'; entries: Map<string, CSObject> };

export type Token =
  | CSObject
  | { type: 'keyword'; value: string }
  | { type: 'arrayStart' }
  | { type: 'arrayEnd' }
  | { type: 'dictStart' }
  | { type: 'dictEnd' };

export interface CSOperation {
  op: string;
  operands: CSObject[];
  /** Byte offset of the first operand (or of the operator if it has none). */
  start: number;
  /** Byte offset just past the operator (past `EI` for inline images). */
  end: number;
}

const WHITESPACE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITESPACE[c] = 1;

const DELIMITER = new Uint8Array(256);
for (const ch of '()<>[]{}/%') DELIMITER[ch.charCodeAt(0)] = 1;

export function isWhitespace(c: number): boolean {
  return WHITESPACE[c] === 1;
}

function isRegular(c: number): boolean {
  return WHITESPACE[c] === 0 && DELIMITER[c] === 0;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export class Lexer {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  private skipWhitespaceAndComments(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WHITESPACE[c]) {
        this.pos++;
      } else if (c === 0x25 /* % */) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  /** Returns the next token, or null at end of input. `tokenStart` is set to its offset. */
  tokenStart = 0;
  next(): Token | null {
    this.skipWhitespaceAndComments();
    const b = this.bytes;
    if (this.pos >= b.length) return null;
    this.tokenStart = this.pos;
    const c = b[this.pos];

    switch (c) {
      case 0x28: // (
        return this.readLiteralString();
      case 0x3c: // <
        if (b[this.pos + 1] === 0x3c) {
          this.pos += 2;
          return { type: 'dictStart' };
        }
        return this.readHexString();
      case 0x3e: // >
        if (b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { type: 'dictEnd' };
        }
        this.pos++;
        return { type: 'keyword', value: '>' };
      case 0x5b: // [
        this.pos++;
        return { type: 'arrayStart' };
      case 0x5d: // ]
        this.pos++;
        return { type: 'arrayEnd' };
      case 0x7b: // {
      case 0x7d: // }
      case 0x29: // ) unbalanced
        this.pos++;
        return { type: 'keyword', value: String.fromCharCode(c) };
      case 0x2f: // /
        return this.readName();
    }

    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      return this.readNumber();
    }

    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    if (this.pos === start) this.pos++; // never stall on unexpected bytes
    const word = latin1(b, start, this.pos);
    if (word === 'true') return { type: 'bool', value: true };
    if (word === 'false') return { type: 'bool', value: false };
    if (word === 'null') return { type: 'null' };
    return { type: 'keyword', value: word };
  }

  private readNumber(): Token {
    const b = this.bytes;
    const start = this.pos;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) this.pos++;
      else break;
    }
    // Tolerate malformed numbers such as "--5" or "1.2.3" the way viewers do.
    let text = latin1(b, start, this.pos);
    text = text.replace(/^([+-])[+-]+/, '$1');
    const value = parseFloat(text);
    return { type: 'number', value: Number.isFinite(value) ? value : 0 };
  }

  private readName(): Token {
    const b = this.bytes;
    this.pos++; // '/'
    let name = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 /* # */ && this.pos + 2 < b.length) {
        const h1 = hexValue(b[this.pos + 1]);
        const h2 = hexValue(b[this.pos + 2]);
        if (h1 >= 0 && h2 >= 0) {
          name += String.fromCharCode(h1 * 16 + h2);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(c);
      this.pos++;
    }
    return { type: 'name', value: name };
  }

  private readLiteralString(): Token {
    const b = this.bytes;
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c /* \ */) {
        if (this.pos >= b.length) break;
        const e = b[this.pos++];
        switch (e) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: case 0x29: case 0x5c: out.push(e); break;
          case 0x0d: // line continuation
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let value = e - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  value = value * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(value & 0xff);
            } else {
              out.push(e);
            }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else {
        out.push(c);
      }
    }
    return { type: 'string', bytes: Uint8Array.from(out) };
  }

  private readHexString(): Token {
    const b = this.bytes;
    this.pos++; // '<'
    const out: number[] = [];
    let high = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) high = v;
      else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    return { type: 'string', bytes: Uint8Array.from(out) };
  }
}

function latin1(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Collects composite objects (arrays/dicts) from a token stream. Returns
 * `undefined` for bare keywords so the caller can treat them as operators.
 */
function readObject(lexer: Lexer, first: Token): CSObject | { type: 'keyword'; value: string } | undefined {
  switch (first.type) {
    case 'arrayStart': {
      const items: CSObject[] = [];
      for (;;) {
        const t = lexer.next();
        if (!t || t.type === 'arrayEnd') break;
        const obj = readObject(lexer, t);
        if (obj && obj.type !== 'keyword') items.push(obj);
      }
      return { type: 'array', items };
    }
    case 'dictStart': {
      const entries = new Map<string, CSObject>();
      let key: string | null = null;
      for (;;) {
        const t = lexer.next();
        if (!t || t.type === 'dictEnd') break;
        const obj = readObject(lexer, t);
        if (!obj || obj.type === 'keyword') continue;
        if (key === null) {
          if (obj.type === 'name') key = obj.value;
        } else {
          entries.set(key, obj);
          key = null;
        }
      }
      return { type: 'dict', entries };
    }
    case 'arrayEnd':
    case 'dictEnd':
      return undefined;
    default:
      return first;
  }
}

/** Parses a content stream into operations with byte ranges. */
export function parseContentStream(bytes: Uint8Array): CSOperation[] {
  const lexer = new Lexer(bytes);
  const ops: CSOperation[] = [];
  let operands: CSObject[] = [];
  let operandStart = -1;

  for (;;) {
    const token = lexer.next();
    if (!token) break;
    const tokenStart = lexer.tokenStart;
    const obj = readObject(lexer, token);
    if (!obj) continue;
    if (obj.type !== 'keyword') {
      if (operandStart < 0) operandStart = tokenStart;
      operands.push(obj);
      continue;
    }
    const start = operandStart >= 0 ? operandStart : tokenStart;
    if (obj.value === 'BI') {
      const end = skipInlineImage(lexer);
      ops.push({ op: 'BI', operands: [], start, end });
    } else {
      ops.push({ op: obj.value, operands, start, end: lexer.pos });
    }
    operands = [];
    operandStart = -1;
  }
  return ops;
}

/** Skips an inline image (`BI … ID <data> EI`), returning the offset after `EI`. */
function skipInlineImage(lexer: Lexer): number {
  const b = lexer.bytes;
  // Parse the image dictionary up to the ID keyword.
  let length = -1;
  let lastKey: string | null = null;
  for (;;) {
    const t = lexer.next();
    if (!t) return b.length;
    if (t.type === 'keyword' && t.value === 'ID') break;
    const obj = readObject(lexer, t);
    if (!obj || obj.type === 'keyword') continue;
    if (lastKey === null && obj.type === 'name') {
      lastKey = obj.value;
    } else {
      if ((lastKey === 'L' || lastKey === 'Length') && obj.type === 'number') length = obj.value;
      lastKey = null;
    }
  }
  // A single whitespace byte separates ID from the data.
  let pos = lexer.pos;
  if (isWhitespace(b[pos])) pos++;
  if (length > 0 && pos + length <= b.length) {
    const after = findEI(b, pos + length);
    if (after > 0) {
      lexer.pos = after;
      return after;
    }
  }
  const after = findEI(b, pos);
  lexer.pos = after > 0 ? after : b.length;
  return lexer.pos;
}

/** Finds an `EI` token that plausibly terminates inline image data. */
function findEI(b: Uint8Array, from: number): number {
  for (let i = from; i < b.length - 1; i++) {
    if (b[i] !== 0x45 || b[i + 1] !== 0x49) continue;
    const before = i === from || isWhitespace(b[i - 1]);
    const afterByte = b[i + 2];
    const after = i + 2 >= b.length || isWhitespace(afterByte) || DELIMITER[afterByte] === 1;
    if (!before || !after) continue;
    // Make sure what follows looks like content-stream text, not binary data.
    let plausible = true;
    for (let j = i + 2; j < Math.min(b.length, i + 12); j++) {
      const c = b[j];
      if (!(WHITESPACE[c] || (c >= 0x20 && c < 0x7f))) {
        plausible = false;
        break;
      }
    }
    if (plausible) return i + 2;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  let s = n.toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function hex(bytes: Uint8Array): string {
  let s = '<';
  for (const byte of bytes) s += byte.toString(16).padStart(2, '0');
  return s + '>';
}

function escapeName(name: string): string {
  let out = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || c === 0x23 || !isRegular(c)) {
      out += '#' + c.toString(16).padStart(2, '0');
    } else {
      out += name[i];
    }
  }
  return out;
}

export function serializeObject(obj: CSObject): string {
  switch (obj.type) {
    case 'number':
      return formatNumber(obj.value);
    case 'string':
      return hex(obj.bytes);
    case 'name':
      return escapeName(obj.value);
    case 'bool':
      return obj.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array':
      return '[' + obj.items.map(serializeObject).join(' ') + ']';
    case 'dict': {
      let s = '<<';
      for (const [k, v] of obj.entries) s += escapeName(k) + ' ' + serializeObject(v) + ' ';
      return s + '>>';
    }
  }
}

export function serializeOperation(operands: CSObject[], op: string): string {
  return operands.length ? operands.map(serializeObject).join(' ') + ' ' + op : op;
}

const encoder = new TextEncoder();

/**
 * Rewrites a stream by replacing the byte ranges of selected operations.
 * Everything that isn't replaced is copied through unchanged.
 */
export function spliceOperations(
  bytes: Uint8Array,
  ops: CSOperation[],
  replacements: Map<number, string>,
): Uint8Array {
  const indices = [...replacements.keys()].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const index of indices) {
    const op = ops[index];
    chunks.push(bytes.subarray(cursor, op.start));
    // Surround with whitespace so the new tokens can't fuse with neighbours.
    chunks.push(encoder.encode(' ' + replacements.get(index)! + '\n'));
    cursor = op.end;
  }
  chunks.push(bytes.subarray(cursor));
  return concatBytes(chunks);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
