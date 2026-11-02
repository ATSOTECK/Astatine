// Generates the PDFs used by the test-suite. Real-world producers (Chrome,
// LibreOffice) are used when installed so the tests exercise the kinds of
// fonts and content streams that "other programs" actually write.
//
//   node scripts/make-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';

const outDir = resolve('test/fixtures');
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'astatine-fixtures-'));

async function pdfLibFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  page.drawText('Hello World from pdf-lib', { x: 72, y: 700, size: 18, font: helv, color: rgb(0.8, 0.1, 0.1) });
  page.drawText('Second line in bold Times', { x: 72, y: 660, size: 14, font: bold });
  page.drawText('Rotated text', { x: 300, y: 300, size: 12, font: helv, rotate: degrees(30) });
  page.drawText('Keep this line', { x: 72, y: 600, size: 12, font: helv });

  // A second page whose text lives inside a form XObject (embedded page).
  const src = await PDFDocument.create();
  const sp = src.addPage([300, 200]);
  sp.drawText('Inside a form XObject', { x: 20, y: 100, size: 16, font: await src.embedFont(StandardFonts.Helvetica) });
  const [embedded] = await doc.embedPdf(await src.save());
  const page2 = doc.addPage([612, 792]);
  page2.drawPage(embedded, { x: 100, y: 400 });
  page2.drawPage(embedded, { x: 100, y: 100 });
  writeFileSync(join(outDir, 'pdflib.pdf'), await doc.save());
}

async function rotatedFixture() {
  // A landscape page made by rotating a portrait page (/Rotate 90), as scanners and print drivers do.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // Text drawn rotated so it reads upright once the page is displayed rotated.
  page.drawText('Upright on a rotated page', { x: 100, y: 100, size: 20, font, rotate: degrees(90) });
  page.drawText('Second rotated line', { x: 140, y: 100, size: 14, font, rotate: degrees(90) });
  writeFileSync(join(outDir, 'rotated.pdf'), await doc.save());
}

async function freeTextFixture() {
  // Mimics the FreeText annotations written by macOS Preview / Acrobat.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Body text underneath', { x: 72, y: 720, size: 12, font });
  const ctx = doc.context;

  const ap = ctx.flateStream(
    'q 1 0 0 rg BT /Helv 14 Tf 2 6 Td (Added in Preview) Tj ET Q',
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 160, 24],
      Resources: { Font: { Helv: font.ref } },
    },
  );
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [100, 500, 260, 524],
    Contents: PDFString.of('Added in Preview'),
    DA: PDFString.of('/Helv 14 Tf 1 0 0 rg'),
    F: 4,
    AP: { N: ctx.register(ap) },
    NM: PDFString.of('preview-annot-1'),
    T: PDFString.of('Someone Else'),
  });
  // A wrapped, multi-line Acrobat-style annotation with rich text.
  const annot2 = ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [100, 300, 220, 380],
    Contents: PDFString.of('A longer note that wraps across several lines'),
    DA: PDFString.of('/TiRo 12 Tf 0 0 1 rg'),
    DS: PDFString.of('font: 12pt Times; color: #0000FF'),
    F: 4,
    NM: PDFString.of('acrobat-annot-2'),
  });
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot), ctx.register(annot2)]));
  writeFileSync(join(outDir, 'freetext.pdf'), await doc.save());
}

async function handWrittenFixture() {
  // Exercises ' and " operators, TJ kerning, Tc/Tw and a non-zero MediaBox origin.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Courier);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  const content = [
    'BT /F1 12 Tf 14 TL 72 700 Td',
    '[(Kerned) -500 (TJ) 250 (array)] TJ',
    "(Apostrophe line) '",
    '2 1 (Quote line) "',
    'ET',
    'BT /F1 10 Tf 1 0 0 1 72 500 Tm 3 Tc 5 Tw (Spaced out words) Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  writeFileSync(join(outDir, 'handwritten.pdf'), await doc.save());
}

async function scaledFixture() {
  // Condensed (Tz), stretched text matrices and tracked (Tc) text, as InDesign and Word produce.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  const content = [
    'BT /F1 14 Tf 80 Tz 72 700 Td (Condensed to eighty percent) Tj ET',
    // Tz and Tc are graphics state, so each case resets what the previous one set.
    'BT /F1 1 Tf 100 Tz 16 0 0 12 72 650 Tm (Matrix wider than tall) Tj ET',
    'BT /F1 12 Tf 1.5 Tc 72 600 Td (Tracked out letters) Tj ET',
    'BT /F1 12 Tf -0.4 Tc 72 560 Td (Tightly tracked letters) Tj ET',
    'BT /F1 12 Tf 0 Tc 72 520 Td (Plain reference line) Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  writeFileSync(join(outDir, 'scaled.pdf'), await doc.save());
}

function officeFixture() {
  // Word-style text in Carlito/Caladea (metric twins of Calibri/Cambria) which LibreOffice
  // embeds but which aren't installed system-wide: the "font not installed" case.
  const soffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  if (!existsSync(soffice)) return console.warn('LibreOffice not found; skipping office.pdf');
  const src = join(work, 'office.html');
  writeFileSync(
    src,
    `<!doctype html><html><body>
      <p style="font-family: Carlito; font-size: 11pt">Calibri-style body text at eleven points for the report.</p>
      <p style="font-family: Carlito; font-size: 11pt"><b>Bold Calibri-style heading text</b></p>
      <p style="font-family: Caladea; font-size: 12pt">Cambria-style serif paragraph at twelve points.</p>
    </body></html>`,
  );
  execFileSync(soffice, ['--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', work, src], {
    stdio: 'ignore',
  });
  copyFileSync(join(work, 'office.pdf'), join(outDir, 'office.pdf'));
}

function chromeFixture() {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome)) return console.warn('Chrome not found; skipping chrome.pdf');
  const html = join(work, 'chrome.html');
  writeFileSync(
    html,
    `<!doctype html><html><body style="font-family: Arial, sans-serif; margin: 48px">
      <h1>Quarterly Report</h1>
      <p>The quick brown fox jumps over the lazy dog. <b>Bold words</b> and <i>italic words</i>.</p>
      <p style="font-family: 'Times New Roman', serif; color: #1a5fb4">Serif paragraph in blue.</p>
      <p style="font-family: 'Courier New', monospace">Monospaced line 12345</p>
      <div style="transform: rotate(-90deg); width: 200px; margin-top: 120px">Sideways text</div>
    </body></html>`,
  );
  const out = join(work, 'chrome.pdf');
  execFileSync(chrome, ['--headless', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, html], {
    stdio: 'ignore',
  });
  copyFileSync(out, join(outDir, 'chrome.pdf'));
}

function libreOfficeFixture() {
  const soffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  if (!existsSync(soffice)) return console.warn('LibreOffice not found; skipping libreoffice.pdf');
  const src = join(work, 'libreoffice.html');
  writeFileSync(
    src,
    `<!doctype html><html><body>
      <h2>Invoice 2026-118</h2>
      <p>Total amount due: 1,250.00 EUR</p>
      <p><b>Payment terms:</b> thirty days.</p>
    </body></html>`,
  );
  execFileSync(soffice, ['--headless', '--convert-to', 'pdf:writer_web_pdf_Export', '--outdir', work, src], {
    stdio: 'ignore',
  });
  copyFileSync(join(work, 'libreoffice.pdf'), join(outDir, 'libreoffice.pdf'));
}

await pdfLibFixture();
await freeTextFixture();
await rotatedFixture();
await scaledFixture();
await handWrittenFixture();
chromeFixture();
libreOfficeFixture();
officeFixture();
rmSync(work, { recursive: true, force: true });
console.log('Fixtures written to', outDir);
