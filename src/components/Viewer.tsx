import Box from '@mui/material/Box';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CSS_PER_POINT, makeViewport } from '../lib/geometry';
import { setCurrentPage, setZoom, useEditor } from '../state/store';
import { PageView } from './PageView';

const PAGE_GAP = 20;
const SIDE_PADDING = 32;

export function Viewer() {
  const doc = useEditor((s) => s.doc);
  const zoom = useEditor((s) => s.zoom);
  const fitWidth = useEditor((s) => s.fitWidth);
  const pageJump = useEditor((s) => s.pageJump);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const anchor = useRef<{ x: number; y: number; contentX: number; contentY: number; zoom: number } | null>(null);

  useEffect(() => {
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(root);
    return () => observer.disconnect();
  }, [root]);

  // Fit-to-width keeps the store's zoom in sync so the toolbar shows a percentage.
  const widest = doc ? Math.max(...doc.pages.map((p) => makeViewport(p, 1).width)) : 0;
  useEffect(() => {
    if (!fitWidth || !width || !widest) return;
    const fit = Math.min(2, Math.max(0.25, (width - SIDE_PADDING * 2) / (widest * CSS_PER_POINT)));
    if (Math.abs(fit - useEditor.getState().zoom) > 0.001) useEditor.setState({ zoom: fit });
  }, [fitWidth, width, widest]);

  const scale = zoom * CSS_PER_POINT;

  // Keep the point under the cursor fixed while zooming with the wheel/pinch.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a || !root) return;
    anchor.current = null;
    const ratio = zoom / a.zoom;
    root.scrollLeft = a.contentX * ratio - a.x;
    root.scrollTop = a.contentY * ratio - a.y;
  }, [zoom, root]);

  useEffect(() => {
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const current = useEditor.getState().zoom;
      const next = Math.min(4, Math.max(0.25, current * Math.exp(-e.deltaY * 0.01)));
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      anchor.current = { x, y, contentX: root.scrollLeft + x, contentY: root.scrollTop + y, zoom: current };
      setZoom(next);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [root]);

  // Track the page in the middle of the view.
  const onScroll = useCallback(() => {
    if (!root) return;
    const mid = root.scrollTop + root.clientHeight / 2;
    const pages = root.querySelectorAll<HTMLElement>('[data-page-index]');
    for (const el of pages) {
      if (el.offsetTop + el.offsetHeight + PAGE_GAP / 2 >= mid) {
        setCurrentPage(Number(el.dataset.pageIndex));
        return;
      }
    }
  }, [root]);

  useEffect(() => {
    if (!root || !pageJump) return;
    const el = root.querySelector<HTMLElement>(`[data-page-index="${pageJump.index}"]`);
    if (el) root.scrollTo({ top: el.offsetTop - PAGE_GAP, behavior: 'auto' });
  }, [pageJump, root]);

  if (!doc) return null;
  return (
    <Box
      ref={setRoot}
      onScroll={onScroll}
      sx={{ position: 'absolute', inset: 0, overflow: 'auto', overflowAnchor: 'none', bgcolor: 'background.default' }}
    >
      <Box
        data-viewer-content
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: `${PAGE_GAP}px`,
          py: `${PAGE_GAP}px`,
          px: `${SIDE_PADDING}px`,
          minWidth: 'min-content',
          position: 'relative',
        }}
      >
        {doc.pages.map((info, index) => (
          <PageView key={index} index={index} info={info} scale={scale} scrollRoot={root} />
        ))}
      </Box>
    </Box>
  );
}
