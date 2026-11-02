import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const asset = (dir: string) => new URL(`/pdfjs/${dir}/`, window.location.href).href;

export interface LoadedPdf {
  task: PDFDocumentLoadingTask;
  pdf: PDFDocumentProxy;
}

export async function loadPdf(bytes: Uint8Array): Promise<LoadedPdf> {
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker, so give it a copy.
    data: bytes.slice(),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
    // Fetch resources from the main thread: works with every webview's custom protocol.
    useWorkerFetch: false,
    enableXfa: false,
  });
  const pdf = await task.promise;
  return { task, pdf };
}

export const { AnnotationMode, Util, TextLayer } = pdfjs;
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
