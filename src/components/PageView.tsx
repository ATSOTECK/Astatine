import Paper from '@mui/material/Paper';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { baselineRatio, displayFont } from '../lib/fonts';
import { itemBox, makeViewport, toUser, uprightUserAngle, type PageInfo, type Viewport } from '../lib/geometry';
import { peekInstalledFont } from '../lib/installedFonts';
import { AnnotationMode, TextLayer } from '../lib/pdfjs';
import type { TextItemGeometry } from '../pdf/textEdit';
import { addText, editExistingText, select, useEditor } from '../state/store';
import { TextObjectView } from './TextObjectView';

/** Safari refuses canvases larger than this many pixels. */
const MAX_CANVAS_PIXELS = 16_000_000;

interface Props {
  index: number;
  info: PageInfo;
  scale: number;
  scrollRoot: HTMLElement | null;
}

function PageViewImpl({ index, info, scale, scrollRoot }: Props) {
  const vp = useMemo(() => makeViewport(info, scale), [info, scale]);
  const pdf = useEditor((s) => s.pdf);
  const version = useEditor((s) => s.pageVersions[index] ?? 0);
  const editable = useEditor((s) => !!s.doc?.editable);
  const tool = useEditor((s) => s.tool);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedKey = useRef<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [items, setItems] = useState<{ version: number; list: TextItemGeometry[] } | null>(null);

  // Render only pages near the viewport, and free the others' canvases.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: scrollRoot,
      rootMargin: '150% 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible && canvas && renderedKey.current) {
      canvas.width = 0;
      canvas.height = 0;
      renderedKey.current = null;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !pdf) return;
    const dpr = window.devicePixelRatio || 1;
    const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height)));
    const key = `${version}|${scale}|${outputScale}`;
    if (renderedKey.current === key) return;

    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: scale * outputScale });
      // Render off-screen and swap in when done, so edits never flash a blank page.
      const off = document.createElement('canvas');
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      task = page.render({ canvas: off, viewport, annotationMode: AnnotationMode.ENABLE });
      await task.promise;
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext('2d')?.drawImage(off, 0, 0);
      off.width = 0;
      renderedKey.current = key;
    })().catch((e: unknown) => {
      if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) {
        console.warn(`Rendering page ${index + 1} failed`, e);
      }
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, pdf, version, scale, index, vp.width, vp.height]);

  // Existing text on the page, for click-to-edit.
  useEffect(() => {
    if (!visible || !pdf || !editable || items?.version === version) return;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      const content = await page.getTextContent();
      if (cancelled) return;
      const list: TextItemGeometry[] = [];
      for (const it of content.items) {
        if (!('str' in it) || it.str.trim() === '' || it.dir === 'ttb' || it.width <= 0) continue;
        list.push({ str: it.str, transform: [...it.transform], width: it.width, height: it.height });
      }
      setItems({ version, list });
    })().catch(() => {
      /* the document was replaced mid-request; a newer effect will run */
    });
    return () => {
      cancelled = true;
    };
  }, [visible, pdf, version, editable, index, items?.version]);

  return (
    <Paper
      ref={containerRef}
      elevation={2}
      square
      data-page-index={index}
      sx={{ position: 'relative', width: vp.width, height: vp.height, flexShrink: 0, bgcolor: '#fff', overflow: 'hidden' }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: vp.width, height: vp.height }} />
      {visible && tool === 'select' && <PdfTextLayer index={index} scale={scale} version={version} />}
      {visible && (
        <PageOverlay
          index={index}
          vp={vp}
          items={editable && tool === 'edit' && items?.version === version ? items.list : null}
        />
      )}
    </Paper>
  );
}

export const PageView = memo(PageViewImpl);

/**
 * pdf.js's text layer: invisible text laid exactly over the rendered page, so
 * the browser's own text selection (highlighting, copying) works in Select mode.
 */
function PdfTextLayer({ index, scale, version }: { index: number; scale: number; version: number }) {
  const pdf = useEditor((s) => s.pdf);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !pdf) return;
    let layer: InstanceType<typeof TextLayer> | null = null;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      container.replaceChildren();
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale }) });
      await layer.render();
    })().catch(() => {
      /* replaced or cancelled */
    });
    return () => {
      cancelled = true;
      layer?.cancel();
      container.replaceChildren();
    };
  }, [pdf, version, scale, index]);
  return <div ref={ref} className="textLayer" style={{ '--total-scale-factor': scale } as CSSProperties} />;
}

interface OverlayProps {
  index: number;
  vp: Viewport;
  items: TextItemGeometry[] | null;
}

function PageOverlay({ index, vp, items }: OverlayProps) {
  const objects = useEditor(useShallow((s) => s.current?.objects.filter((o) => o.pageIndex === index) ?? []));
  const selectedId = useEditor((s) => s.selectedId);
  const editingId = useEditor((s) => s.editingId);
  const hiddenKeys = useEditor((s) => s.current?.hiddenKeys);
  const activatingKeys = useEditor((s) => s.activatingKeys);
  const tool = useEditor((s) => s.tool);
  const editable = useEditor((s) => !!s.doc?.editable);
  const busy = useEditor((s) => !!s.busy);

  const readOnly = tool === 'select';
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly || e.button !== 0 || e.target !== e.currentTarget) return;
    if (tool === 'text' && editable) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const X = e.clientX - rect.left;
      const Y = e.clientY - rect.top;
      const { defaultStyle } = useEditor.getState();
      const sizePx = defaultStyle.size * vp.scale;
      const lineHeight = 1.2;
      const installed = peekInstalledFont(defaultStyle.font, defaultStyle.bold, defaultStyle.italic);
      const baseline = baselineRatio(displayFont(defaultStyle, '', installed).css, lineHeight) * sizePx;
      // Centre the first line on the pointer, reading left-to-right on screen.
      const [x, y] = toUser(vp, X, Y - (lineHeight * sizePx) / 2 + baseline);
      addText(index, x, y, uprightUserAngle(vp));
    } else {
      select(null);
    }
  };

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        inset: 0,
        cursor: tool === 'text' && editable ? 'text' : 'default',
        // In Select mode, drags go to the text layer underneath (text boxes stay selectable).
        pointerEvents: readOnly ? 'none' : undefined,
      }}
    >
      {items?.map((item, i) => {
        const box = itemBox(vp, item.transform, item.width);
        return (
          <div
            key={i}
            className="text-hitbox"
            title={busy ? undefined : 'Click to edit this text'}
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height * 1.15,
              transform: `rotate(${box.angle}rad) translateY(${-box.height * 0.9}px)`,
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              void editExistingText(index, item, { clientX: e.clientX, clientY: e.clientY });
            }}
          />
        );
      })}
      {objects.map((obj) => {
        const pristine =
          !!obj.annotKey && !hiddenKeys?.includes(obj.annotKey) && !activatingKeys.includes(obj.annotKey);
        return (
          <TextObjectView
            key={obj.id}
            obj={obj}
            vp={vp}
            selected={selectedId === obj.id}
            editing={editingId === obj.id}
            pristine={pristine}
            readOnly={readOnly}
          />
        );
      })}
    </div>
  );
}
