/**
 * Extracts one font from a TrueType/OpenType collection (.ttc/.otc) as a
 * standalone font file. Browsers' FontFace and pdf-lib both need a single
 * font, while many system fonts (Helvetica on macOS, for one) ship as
 * collections.
 */

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function isCollection(data: Uint8Array): boolean {
  return data.length >= 12 && data[0] === 0x74 && data[1] === 0x74 && data[2] === 0x63 && data[3] === 0x66; // "ttcf"
}

export function collectionSize(data: Uint8Array): number {
  if (!isCollection(data)) return 1;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(8);
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const padded = bytes.length + ((4 - (bytes.length % 4)) % 4);
  for (let i = 0; i < padded; i += 4) {
    const word = ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** Returns face `index` of a collection as its own font; non-collections are returned as is. */
export function extractFace(data: Uint8Array, index: number): Uint8Array {
  if (!isCollection(data)) return data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(8);
  if (index < 0 || index >= count) throw new Error(`Font collection has no face ${index}`);
  const offset = view.getUint32(12 + 4 * index);
  const sfntVersion = view.getUint32(offset);
  const numTables = view.getUint16(offset + 4);

  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + 16 * i;
    const start = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    if (start + length > data.length) throw new Error('Font collection is truncated');
    tables.push({ tag: tag(view, rec), data: data.subarray(start, start + length) });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const headerSize = 12 + 16 * tables.length;
  const total = tables.reduce((n, t) => n + t.data.length + ((4 - (t.data.length % 4)) % 4), headerSize);
  const out = new Uint8Array(total);
  const w = new DataView(out.buffer);
  const entrySelector = Math.floor(Math.log2(tables.length));
  const searchRange = 2 ** entrySelector * 16;
  w.setUint32(0, sfntVersion);
  w.setUint16(4, tables.length);
  w.setUint16(6, searchRange);
  w.setUint16(8, entrySelector);
  w.setUint16(10, tables.length * 16 - searchRange);

  let cursor = headerSize;
  tables.forEach((t, i) => {
    const rec = 12 + 16 * i;
    for (let k = 0; k < 4; k++) w.setUint8(rec + k, t.tag.charCodeAt(k));
    w.setUint32(rec + 4, checksum(t.data));
    w.setUint32(rec + 8, cursor);
    w.setUint32(rec + 12, t.data.length);
    out.set(t.data, cursor);
    cursor += t.data.length + ((4 - (t.data.length % 4)) % 4);
  });
  return out;
}
