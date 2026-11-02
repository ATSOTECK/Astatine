import {
  decodePDFRawStream,
  PDFArray,
  PDFContext,
  PDFDict,
  PDFFlateStream,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';

/** Small, defensive helpers over pdf-lib's low-level object model. */

export function resolve(context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  let current = obj;
  for (let i = 0; current instanceof PDFRef && i < 32; i++) {
    current = context.lookup(current);
  }
  return current instanceof PDFRef ? undefined : current;
}

export function dictGet(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return resolve(dict.context, dict.get(PDFName.of(key)));
}

export function dictOf(obj: PDFObject | undefined): PDFDict | undefined {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFStream) return obj.dict;
  return undefined;
}

export function getDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  return dictOf(dictGet(dict, key));
}

export function getNumber(dict: PDFDict | undefined, key: string): number | undefined {
  const v = dictGet(dict, key);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getName(dict: PDFDict | undefined, key: string): string | undefined {
  const v = dictGet(dict, key);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function getArray(dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const v = dictGet(dict, key);
  return v instanceof PDFArray ? v : undefined;
}

export function getText(dict: PDFDict | undefined, key: string): string | undefined {
  const v = dictGet(dict, key);
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return undefined;
}

export function arrayNumbers(context: PDFContext, arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = resolve(context, arr.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

export function arrayItems(context: PDFContext, arr: PDFArray | undefined): (PDFObject | undefined)[] {
  if (!arr) return [];
  const out: (PDFObject | undefined)[] = [];
  for (let i = 0; i < arr.size(); i++) out.push(resolve(context, arr.get(i)));
  return out;
}

/** Returns the decoded bytes of a stream, or null if it uses an unsupported filter. */
export function streamBytes(stream: PDFObject | undefined): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) {
      return decodePDFRawStream(stream).decode();
    }
    if (stream instanceof PDFFlateStream) {
      return stream.getUnencodedContents();
    }
    if (stream instanceof PDFStream) {
      return stream.getContents();
    }
  } catch {
    return null;
  }
  return null;
}

/** All content streams of a page, decoded and joined with newlines. */
export function pageContentBytes(page: PDFPage): Uint8Array {
  const context = page.node.context;
  const contents = resolve(context, page.node.get(PDFName.of('Contents')));
  const streams: PDFObject[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = resolve(context, contents.get(i));
      if (s) streams.push(s);
    }
  } else if (contents) {
    streams.push(contents);
  }
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    const bytes = streamBytes(s);
    if (bytes) parts.push(bytes);
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
    out[offset++] = 0x0a;
  }
  return out;
}

/** Effective (possibly inherited) resources dictionary of a page. */
export function pageResources(page: PDFPage): PDFDict | undefined {
  return page.node.Resources();
}

/** Shallow-copies a dictionary into a new direct dictionary in the same context. */
export function shallowCopyDict(dict: PDFDict | undefined, context: PDFContext): PDFDict {
  const copy = context.obj({});
  if (dict) {
    for (const [k, v] of dict.entries()) copy.set(k, v);
  }
  return copy;
}
