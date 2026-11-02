# Astatine
Astatine PDF Editor

A desktop PDF editor built with **Tauri 2, React, MUI and TypeScript**. Open a PDF, then:

- **Edit text that's already in it.** Click any line, including text produced by Word, Chrome, LibreOffice or any other program, and type over it.
- **Add new text** anywhere, with font, size, colour, bold/italic and an optional background.
- **Edit text boxes made by other editors.** FreeText annotations from Preview, Acrobat, Firefox, Foxit and others open as editable boxes.

## Using it

| | |
|---|---|
| Open | **Open** button, ⌘O, drag a PDF onto the window, or "Open With → PDF Editor" |
| Select text | **Select** mode (V), the default: drag to highlight text, ⌘C to copy, ⌘A for all text. Nothing can be changed in this mode |
| Edit existing text | **Edit** mode (E), then click a line of text. A box appears with the caret where you clicked. Just clicking isn't an edit: if you click away without changing anything, the original is left exactly as it was and there's nothing to undo |
| Add text | **Add Text** mode (T), then click on the page and type |
| Move / restyle | In Edit mode, select a box (click), drag it, use the formatting bar; arrow keys nudge (⇧ for 10pt) |
| Edit a box | Click it again, double-click, or press Enter. Esc finishes |
| Wrap width | Drag the handle on a selected box's right edge; double-click the handle to size to fit |
| Delete | Delete / Backspace, or the bin icon |
| Undo / Redo | ⌘Z / ⇧⌘Z (also the toolbar). Only real changes are steps; clicking a line, changing it and undoing brings the original text back in one step |
| Save | ⌘S saves over the open file, ⇧⌘S is Save As…; **Save Flattened Copy…** writes every text box into the page content |
| Zoom | ⌘+ / ⌘− / ⌘0, the zoom menu, or ⌘/Ctrl + scroll / pinch |
| Theme | Palette button (top right): Match System, Light, Dark, Gruvbox, Solarized, Catppuccin, Nord, Dracula. Remembered between launches |

## How editing works

**Text in the page content** (what most programs produce) is edited like this:

1. pdf.js finds the text runs on the page; these are the clickable outlines.
2. When you click one, `src/pdf/interpreter.ts` interprets the page's content stream, including nested form XObjects, and works out the position of every glyph. It handles simple, Type0/CID and Type3 fonts, `Tj`/`TJ`/`'`/`"`, `Tc`/`Tw`/`Tz`/`Ts`, the CTM, and colour.
3. `src/pdf/rewrite.ts` removes exactly the glyphs inside that run. Each removed glyph is swapped for a `TJ` spacing adjustment of the same advance, so the rest of the line doesn't move. Shared form XObjects are copied first so other pages aren't affected.
4. The run becomes an editable box with the same size, colour and angle, and the **same font**:
   - if the original is one of the standard PDF fonts (Helvetica, Times, Courier), that font;
   - otherwise the same font installed on this computer. It is matched by PostScript name (e.g. `Arial-BoldMT`) and then by family, weight and slant (so `HelveticaNeue-Light` stays Light). The installed font file is shown on screen and embedded (as a subset) when saving, so what you see is what gets written;
   - if that font isn't installed, or its licence forbids embedding, the font chosen in the font list is used instead and the formatting bar says the original font is missing. Weight, slant and colour still match. The size is adjusted so the substitute takes the same width as the original: substitutes are often much wider (Helvetica vs. Calibri), and at the same point size they would look bigger and run into the next text. Picking another font re-fits it; typing a size turns this off.

   Condensed or expanded type (`Tz`, stretched text matrices) and letter spacing (`Tc`) are kept too, on screen and in the saved file.
5. On save the text is drawn back into the page.

Removed text is really gone from the saved file: objects that are no longer referenced (such as the old content streams) are dropped before writing.

**FreeText annotations** are read with their text, font, size and colour. The ones you don't touch are written back unchanged. Edited and new ones get a fresh appearance stream plus `/DA`, `/DS` and `/RC`, so they stay editable in Acrobat, Preview and others.

**Fonts.** The font list has the three standard PDF fonts (nothing is embedded) and every font installed on the computer (a subset is embedded on save). Fonts inside `.ttc` collections, such as Helvetica on macOS, are handled too. On macOS the fonts bundled inside Microsoft Office and LibreOffice count as installed, since documents made with them use those fonts (Calibri, Cambria, Carlito, Liberation…). If the chosen font lacks a character you type (the standard fonts only cover Western-European text), that text uses an embedded subset of **Liberation Sans** and a "Unicode font" chip appears in the formatting bar.

## Development

Prerequisites: Node 22+, pnpm, Rust, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/).

```sh
pnpm install
pnpm tauri dev          # run the desktop app with hot reload
pnpm tauri build        # build an installable bundle (.app/.dmg, .msi, .deb/.AppImage…)

pnpm dev                # UI only, in a browser (file input + downloads instead of native dialogs)
pnpm test               # PDF engine tests (vitest, checked against pdf.js text extraction)
pnpm typecheck
pnpm fixtures           # regenerate test PDFs (uses Chrome and LibreOffice if installed)
```

### Layout

```
src/pdf/          PDF engine (no DOM; runs in tests)
  lexer.ts          content-stream tokenizer/parser that keeps byte ranges for splicing
  fonts.ts, cmap.ts, standardFonts.ts   glyph widths and code splitting for every font type
  fontMatch.ts      matching PDF font names to installed fonts (PostScript name, family, weight, slant)
  sfnt.ts           extracts single fonts from .ttc collections
  interpreter.ts    graphics/text state machine → glyph geometry
  rewrite.ts        glyph removal, copy-on-write form XObjects
  textEdit.ts       pdf.js text run → glyphs → editable text object
  freeText.ts       read/write FreeText annotations (DA/DS/RC/AP)
  session.ts        open / convert / export, unreachable-object pruning
src/state/store.ts  editor state, undo/redo snapshots (zustand)
src/theme/          colour themes and the saved theme choice
src/components/     viewer, pages, text boxes, toolbars (MUI)
src/lib/            pdf.js setup, viewport geometry, font CSS, baseline measurement, installed-font loading
src/platform/       Tauri dialogs + binary IPC, browser fallback
src-tauri/          Rust: file read/atomic write commands, installed-font list (fontdb), "Open With" handling
test/               vitest suite and fixture PDFs (pdf-lib, Chrome, LibreOffice, hand-written)
```

The CSP in `src-tauri/tauri.conf.json` allows inline styles because MUI (Emotion) injects them at runtime. `dangerousDisableAssetCspModification: ["style-src"]` stops Tauri from adding nonces that would disable `'unsafe-inline'`.

## Limitations

- Existing page text is edited **one run at a time**: usually a line, or a part of a line where the font changes. Paragraphs don't reflow, so making text much longer can overlap whatever follows it on the line. Drag the box or shorten the text if that happens.
- The original font is reused only if it's installed on the computer. Fonts embedded in PDFs are usually partial subsets, so they can't be reused for new text. In the browser build (`pnpm dev`) installed fonts are only available in Chromium, through the Local Font Access permission.
- Text that is part of an **image** (a scan without OCR, or text converted to outlines) can't be edited. For OCR'd scans the invisible text layer is replaced and a white background is added to cover the original pixels.
- Vertical (top-to-bottom) text isn't editable.
- **Encrypted** PDFs open read-only.
- Saving rewrites the whole file, so earlier incremental-update history isn't kept and digital signatures become invalid (as with any edit).
- Rich text with several styles inside one annotation is simplified to a single style once you edit it; FreeText callout lines aren't redrawn.
