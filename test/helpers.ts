import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = resolve('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve('test/fixtures', name)));
}

export interface SimpleItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export function openWithPdfjs(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
    cMapUrl: resolve('node_modules/pdfjs-dist/cmaps') + '/',
    verbosity: 0,
  });
}

export async function textItems(bytes: Uint8Array, pageIndex = 0): Promise<SimpleItem[]> {
  const task = openWithPdfjs(bytes);
  const doc = await task.promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();
  const items: SimpleItem[] = [];
  for (const i of content.items) {
    if ('str' in i && i.str.trim() !== '') {
      items.push({ str: i.str, transform: [...i.transform], width: i.width, height: i.height });
    }
  }
  await task.destroy();
  return items;
}

export async function pageText(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  return (await textItems(bytes, pageIndex)).map((i) => i.str).join(' | ');
}
