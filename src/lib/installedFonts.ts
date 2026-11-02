import fontkit from '@pdf-lib/fontkit';
import { invoke } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import type { InstalledFontRef } from '../model/types';
import {
  faceForRef,
  familyNames,
  isBoldWeight,
  matchSourceFont,
  normalizeName,
  type InstalledFace,
  type SourceFontInfo,
} from '../pdf/fontMatch';
import { collectionSize, extractFace, isCollection } from '../pdf/sfnt';
import { inTauri } from '../platform/files';

/**
 * Fonts installed on this computer. The same font file is used to show text
 * on screen (via FontFace) and to embed it when saving, so what you see is
 * what gets written.
 */

type FontkitFont = ReturnType<typeof fontkit.create>;

export interface LoadedFace {
  face: InstalledFace;
  /** Standalone font file (extracted from its collection if needed). */
  bytes: Uint8Array;
  /** CSS family name the face is registered under. */
  cssFamily: string;
  font: FontkitFont;
}

// --- Sources -----------------------------------------------------------------

interface LocalFontData {
  postscriptName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}

const browserFonts = new Map<string, LocalFontData>();

function styleToWeight(style: string): number {
  const s = style.toLowerCase();
  if (/thin|hairline/.test(s)) return 100;
  if (/(extra|ultra)\s*light/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/(semi|demi)\s*bold/.test(s)) return 600;
  if (/(extra|ultra)\s*bold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}

async function queryFaces(): Promise<InstalledFace[]> {
  if (inTauri) return invoke<InstalledFace[]>('list_fonts');
  // Browser build: the Local Font Access API (Chromium), when permitted.
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (!query) return [];
  try {
    const fonts = await query();
    return fonts.map((f) => {
      browserFonts.set(f.postscriptName, f);
      return {
        path: f.postscriptName,
        index: -1,
        postscriptName: f.postscriptName,
        family: f.family,
        weight: styleToWeight(f.style),
        italic: /italic|oblique/i.test(f.style),
      };
    });
  } catch {
    return [];
  }
}

let facesPromise: Promise<InstalledFace[]> | null = null;

export function listInstalledFaces(): Promise<InstalledFace[]> {
  if (!facesPromise) {
    facesPromise = queryFaces().catch(() => []);
    void facesPromise.then((faces) => {
      families = familyNames(faces);
      notify();
    });
  }
  return facesPromise;
}

async function readFaceFile(face: InstalledFace): Promise<Uint8Array> {
  if (inTauri) {
    const data = new Uint8Array(await invoke<ArrayBuffer>('read_file', { path: face.path }));
    return extractFace(data, face.index);
  }
  const data = new Uint8Array(await (await browserFonts.get(face.postscriptName)!.blob()).arrayBuffer());
  if (!isCollection(data)) return data;
  // Browsers hand back the whole collection; find the face by name.
  for (let i = 0; i < collectionSize(data); i++) {
    const single = extractFace(data, i);
    if (fontkit.create(single).postscriptName === face.postscriptName) return single;
  }
  throw new Error(`${face.postscriptName} not found in its font collection`);
}

// --- Loading -----------------------------------------------------------------

const loads = new Map<string, Promise<LoadedFace | null>>();

/**
 * Loads a face for display and embedding. Returns null if it can't be read or
 * parsed, or if its licence doesn't allow embedding it in documents.
 */
export function loadFace(face: InstalledFace): Promise<LoadedFace | null> {
  let load = loads.get(face.postscriptName);
  if (!load) {
    load = (async () => {
      try {
        const bytes = await readFaceFile(face);
        const font = fontkit.create(bytes);
        const fsType = (font['OS/2'] as { fsType?: number } | undefined)?.fsType ?? 0;
        if ((fsType & 0x000f) === 0x0002) return null; // "Restricted License embedding"
        const cssFamily = `Astatine ${face.postscriptName}`;
        const fontFace = new FontFace(cssFamily, bytes as BufferSource);
        await fontFace.load();
        document.fonts.add(fontFace);
        return { face, bytes, cssFamily, font };
      } catch (e) {
        console.warn(`Font ${face.postscriptName} can't be used`, e);
        return null;
      }
    })();
    loads.set(face.postscriptName, load);
  }
  return load;
}

// --- Resolution for styles (with a React subscription) ------------------------

let families: string[] = [];
let version = 0;
const listeners = new Set<() => void>();
const resolved = new Map<string, LoadedFace | null>();
const resolving = new Map<string, Promise<LoadedFace | null>>();

function notify() {
  version++;
  for (const l of listeners) l();
}

function refKey(ref: InstalledFontRef, bold: boolean, italic: boolean): string {
  return `${normalizeName(ref.family)}|${ref.face ?? ''}|${bold}|${italic}`;
}

/** The loaded face for a style's installed font, or null if it isn't available. */
export function resolveInstalledFont(ref: InstalledFontRef, bold: boolean, italic: boolean): Promise<LoadedFace | null> {
  const key = refKey(ref, bold, italic);
  let pending = resolving.get(key);
  if (!pending) {
    pending = (async () => {
      const faces = await listInstalledFaces();
      const face = faceForRef(faces, ref, bold, italic);
      const loaded = face ? await loadFace(face) : null;
      resolved.set(key, loaded);
      notify();
      return loaded;
    })();
    resolving.set(key, pending);
  }
  return pending;
}

/** Non-hook lookup: loaded face, null if unavailable, undefined if not resolved yet. */
export function peekInstalledFont(ref: InstalledFontRef | undefined, bold: boolean, italic: boolean): LoadedFace | null | undefined {
  if (!ref) return undefined;
  return resolved.get(refKey(ref, bold, italic));
}

/**
 * React hook: the loaded face for an installed font (null when unavailable,
 * undefined while loading or when the style uses a standard font).
 */
export function useInstalledFont(ref: InstalledFontRef | undefined, bold: boolean, italic: boolean): LoadedFace | null | undefined {
  useSyncExternalStore(subscribe, getVersion);
  if (!ref) return undefined;
  const key = refKey(ref, bold, italic);
  if (!resolved.has(key)) {
    void resolveInstalledFont(ref, bold, italic);
    return undefined;
  }
  return resolved.get(key);
}

/** React hook: installed font family names (empty until the list has loaded). */
export function useInstalledFamilies(): string[] {
  useSyncExternalStore(subscribe, getVersion);
  return families;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getVersion() {
  return version;
}

/**
 * Finds the installed font matching the font of some existing PDF text:
 * exact PostScript name first, then the closest face of the same family.
 */
export async function findInstalledMatch(
  source: SourceFontInfo,
): Promise<{ ref: InstalledFontRef; bold: boolean; italic: boolean } | null> {
  const faces = await listInstalledFaces();
  for (const face of matchSourceFont(faces, source)) {
    const loaded = await loadFace(face);
    if (!loaded) continue;
    const bold = isBoldWeight(face.weight);
    const ref = { family: face.family, face: face.postscriptName };
    resolved.set(refKey(ref, bold, face.italic), loaded);
    notify();
    return { ref, bold, italic: face.italic };
  }
  return null;
}

/** Font bytes for saving (used by the PDF exporter). */
export async function installedFontBytes(ref: InstalledFontRef, bold: boolean, italic: boolean) {
  const loaded = await resolveInstalledFont(ref, bold, italic);
  return loaded ? { key: loaded.face.postscriptName, bytes: loaded.bytes } : null;
}
