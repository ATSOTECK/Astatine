export type RGB = [number, number, number];

/** The three standard PDF font families (always available, never embedded). */
export type FontFamily = 'Helvetica' | 'Times' | 'Courier';

/** A font installed on this computer; embedded (subset) into the PDF when saved. */
export interface InstalledFontRef {
  family: string;
  /**
   * Exact face, as a PostScript name (e.g. "Helvetica-Light"), when it was
   * matched from existing text. Without it the face is picked from `family`
   * using the bold/italic flags.
   */
  face?: string;
}

export interface TextStyle {
  /** Standard PDF family; used directly, or as the fallback when `font` is unavailable. */
  family: FontFamily;
  /** Installed font to use instead of the standard family. */
  font?: InstalledFontRef;
  bold: boolean;
  italic: boolean;
  /** Font size in PDF points (user-space units). */
  size: number;
  color: RGB;
}

/**
 * - `annotation`: a FreeText annotation (what Preview, Acrobat comments,
 *   Firefox, Foxit… create when you "add text"). Stays editable everywhere.
 * - `content`: text that is drawn into the page itself. Used for edits of
 *   existing page text (the original glyphs are removed from the page).
 */
export type TextObjectKind = 'annotation' | 'content';

export interface TextObject {
  id: string;
  pageIndex: number;
  kind: TextObjectKind;
  text: string;
  /** Origin of the first line's baseline, in page user space. */
  x: number;
  y: number;
  /** Baseline direction in degrees, counter-clockwise in user space. */
  angle: number;
  style: TextStyle;
  /** Line spacing as a multiple of the font size. */
  lineHeight: number;
  /** Wrap width in user-space units, or null to size to the text. */
  wrapWidth: number | null;
  /** Fill behind the text (e.g. white to cover scanned text), or null. */
  background: RGB | null;
  /** Horizontal glyph scale kept from the original text (0.8 = condensed); default 1. */
  hScale?: number;
  /** Extra space after each character in user-space units (original tracking); default 0. */
  charSpacing?: number;
  /**
   * For text shown in a substitute font: the original's natural width (at
   * hScale 1) and size, so the substitute is sized to take the same space,
   * also when another font is picked later.
   */
  fit?: { text: string; width: number; size: number };
  /** Key ("page:index") of the existing annotation this object edits. */
  annotKey?: string;
  /** Font of the text this object replaced or was read from, and whether it was found. */
  sourceFont?: SourceFont;
}

export interface SourceFont {
  /** Name as it appears in the PDF, e.g. "Calibri-Bold". */
  name: string;
  /** False when the font isn't installed and the user's chosen font is used instead. */
  matched: boolean;
}

/** A FreeText annotation that existed in the file when it was opened. */
export interface OriginalAnnotation {
  key: string;
  pageIndex: number;
  /** The annotation as parsed, for detecting whether it was changed. */
  object: TextObject;
  /** Whether it has an appearance stream we can show until it is edited. */
  hasAppearance: boolean;
}

export const DEFAULT_LINE_HEIGHT = 1.2;

/** Inner padding of text boxes written as annotations, in points. */
export const ANNOTATION_PADDING = 2;
