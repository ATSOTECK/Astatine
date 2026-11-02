import { useEffect } from 'react';
import { CSS_PER_POINT, deltaToUser, makeViewport } from '../lib/geometry';
import {
  deleteObject,
  fitWidth,
  objectById,
  redo,
  save,
  select,
  setTool,
  setZoom,
  startEditing,
  stopEditing,
  undo,
  updateObject,
  updateStyle,
  useEditor,
  zoomStep,
} from '../state/store';
import { requestOpen } from './useFileActions';

function isFormField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'combobox';
}

/** Moves the selected box by whole points in screen directions. */
function nudge(dx: number, dy: number) {
  const { selectedId, doc, zoom } = useEditor.getState();
  const obj = objectById(selectedId);
  if (!obj || !doc) return;
  const vp = makeViewport(doc.pages[obj.pageIndex], zoom * CSS_PER_POINT);
  const [du, dv] = deltaToUser(vp, dx * vp.scale, dy * vp.scale);
  updateObject(obj.id, { x: obj.x + du, y: obj.y + dv });
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const inField = isFormField(e.target);
      const editing = !!state.editingId;

      if (mod && !e.altKey) {
        if (key === 'o') {
          e.preventDefault();
          void requestOpen();
          return;
        }
        if (key === 's') {
          e.preventDefault();
          void save(e.shiftKey ? 'saveAs' : 'save');
          return;
        }
        if (key === '=' || key === '+') {
          e.preventDefault();
          zoomStep(1);
          return;
        }
        if (key === '-') {
          e.preventDefault();
          zoomStep(-1);
          return;
        }
        if (key === '0') {
          e.preventDefault();
          if (state.fitWidth) setZoom(1);
          else fitWidth();
          return;
        }
        // Select mode: ⌘A selects the document's text rather than the whole window.
        if (key === 'a' && !inField && state.tool === 'select') {
          const pages = document.querySelector('[data-viewer-content]');
          if (pages) {
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(pages);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
          }
          return;
        }
        if (editing && (key === 'b' || key === 'i')) {
          e.preventDefault();
          const obj = objectById(state.editingId);
          if (obj) updateStyle(key === 'b' ? { bold: !obj.style.bold } : { italic: !obj.style.italic });
          return;
        }
        // Inside text fields, let the browser handle its own undo/redo.
        if (!inField && key === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if (!inField && key === 'y') {
          e.preventDefault();
          redo();
          return;
        }
        return;
      }

      if (inField || e.altKey) return;
      const selected = state.selectedId;
      switch (e.key) {
        case 'Escape':
          if (editing) stopEditing();
          else if (state.tool === 'text') setTool('edit');
          else if (state.tool === 'select') window.getSelection()?.removeAllRanges();
          else select(null);
          break;
        case 'Delete':
        case 'Backspace':
          if (selected) {
            e.preventDefault();
            deleteObject(selected);
          }
          break;
        case 'Enter':
          if (selected) {
            e.preventDefault();
            startEditing(selected);
          }
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!selected) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          nudge(dx, dy);
          break;
        }
        case 't':
        case 'T':
          if (state.doc?.editable) setTool('text');
          break;
        case 'e':
        case 'E':
          if (state.doc?.editable) setTool('edit');
          break;
        case 'v':
        case 'V':
          if (state.doc) setTool('select');
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
