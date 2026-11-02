import { memo, useLayoutEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { baselineRatio, displayFont } from '../lib/fonts';
import { useInstalledFont } from '../lib/installedFonts';
import { cssAngle, deltaToUser, toCss, type Viewport } from '../lib/geometry';
import type { TextObject } from '../model/types';
import { cssHex } from '../pdf/freeText';
import {
  beginGesture,
  endGesture,
  select,
  startEditing,
  stopEditing,
  updateObject,
  useEditor,
} from '../state/store';

interface Props {
  obj: TextObject;
  vp: Viewport;
  selected: boolean;
  editing: boolean;
  /** An untouched annotation whose own appearance is still drawn on the canvas. */
  pristine: boolean;
  /** Select mode: the text can be highlighted and copied, nothing else. */
  readOnly?: boolean;
}

/** Reads the plain text of a contentEditable element, whichever way the browser broke lines. */
function domText(el: HTMLElement): string {
  let out = '';
  const walk = (node: Node, isLast: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data;
    } else if (node.nodeName === 'BR') {
      if (!isLast) out += '\n';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const block = node.nodeName === 'DIV' || node.nodeName === 'P';
      if (block && out !== '' && !out.endsWith('\n')) out += '\n';
      node.childNodes.forEach((child, i) => walk(child, i === node.childNodes.length - 1));
    }
  };
  el.childNodes.forEach((child, i) => walk(child, i === el.childNodes.length - 1));
  return out.replace(/ /g, ' ');
}

function placeCaret(el: HTMLElement, hint: { clientX: number; clientY: number } | null) {
  el.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  let range: Range | null = null;
  if (hint) {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = doc.caretPositionFromPoint?.(hint.clientX, hint.clientY);
    if (pos && el.contains(pos.offsetNode)) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(hint.clientX, hint.clientY);
      if (r && el.contains(r.startContainer)) range = r;
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function TextObjectViewImpl({ obj, vp, selected, editing, pristine, readOnly = false }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const editStartText = useRef(obj.text);
  const caretHint = useEditor((s) => (s.caretHint?.id === obj.id ? s.caretHint : null));

  const installed = useInstalledFont(obj.style.font, obj.style.bold, obj.style.italic);
  const font = displayFont(obj.style, obj.text, installed).css;
  const sizePx = obj.style.size * vp.scale;
  const baseline = baselineRatio(font, obj.lineHeight) * sizePx;
  const [left, top] = toCss(vp, obj.x, obj.y);
  const angle = cssAngle(vp, obj.angle);
  // Condensed/expanded type and tracking kept from the original text. The element is
  // scaled horizontally, so lengths inside it are divided by the scale.
  const hScale = obj.hScale ?? 1;
  const charSpacing = obj.charSpacing ?? 0;
  const transforms = [angle && `rotate(${angle}rad)`, hScale !== 1 && `scaleX(${hScale})`].filter(Boolean);

  if (!editing) editStartText.current = obj.text;

  useLayoutEffect(() => {
    if (editing && ref.current) placeCaret(ref.current, caretHint);
    // Only when editing starts; later caret moves are the user's.
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly) return; // native text selection
    e.stopPropagation();
    if (editing || e.button !== 0) return;
    e.preventDefault();
    const wasSelected = selected;
    select(obj.id);

    const startX = e.clientX;
    const startY = e.clientY;
    const origin = { x: obj.x, y: obj.y };
    let dragging = false;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const dX = ev.clientX - startX;
      const dY = ev.clientY - startY;
      if (!dragging && Math.hypot(dX, dY) < 3) return;
      if (!dragging) {
        dragging = true;
        beginGesture();
      }
      const [du, dv] = deltaToUser(vp, dX, dY);
      updateObject(obj.id, { x: origin.x + du, y: origin.y + dv });
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      if (dragging) endGesture();
      else if (wasSelected && ev.type === 'pointerup') startEditing(obj.id, { clientX: ev.clientX, clientY: ev.clientY });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onResizePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = (el.offsetWidth * hScale) / vp.scale;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    beginGesture();
    const move = (ev: PointerEvent) => {
      // Project the pointer movement onto the text direction.
      const along = (ev.clientX - startX) * Math.cos(angle) + (ev.clientY - startY) * Math.sin(angle);
      updateObject(obj.id, { wrapWidth: Math.max(obj.style.size, startWidth + along / vp.scale) });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      endGesture();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const style: CSSProperties = {
    left,
    top: top - baseline,
    transformOrigin: `0px ${baseline}px`,
    transform: transforms.length ? transforms.join(' ') : undefined,
    letterSpacing: charSpacing ? (charSpacing / hScale) * vp.scale : undefined,
    fontFamily: font.fontFamily,
    fontWeight: font.fontWeight,
    fontStyle: font.fontStyle,
    // The PDF is written without kerning, so don't kern on screen either.
    fontKerning: 'none',
    fontSynthesis: 'none',
    fontSize: sizePx,
    lineHeight: obj.lineHeight,
    color: pristine && !editing ? 'transparent' : cssHex(obj.style.color),
    caretColor: cssHex(obj.style.color),
    whiteSpace: obj.wrapWidth !== null ? 'pre-wrap' : 'pre',
    width: obj.wrapWidth !== null ? (obj.wrapWidth / hScale) * vp.scale : undefined,
    minWidth: editing ? Math.max(4, sizePx * 0.3) : undefined,
    minHeight: obj.lineHeight * sizePx,
    background: obj.background && !(pristine && !editing) ? cssHex(obj.background) : undefined,
  };

  const className = ['text-object', readOnly && 'readonly', !readOnly && selected && 'selected', editing && 'editing']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      key={editing ? 'editing' : 'view'}
      ref={ref}
      className={className}
      style={style}
      data-object-id={obj.id}
      contentEditable={editing ? 'plaintext-only' : undefined}
      suppressContentEditableWarning
      spellCheck={editing}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        if (readOnly) return;
        e.stopPropagation();
        if (!editing) startEditing(obj.id, { clientX: e.clientX, clientY: e.clientY });
      }}
      onInput={(e) => updateObject(obj.id, { text: domText(e.currentTarget) })}
      onBlur={(e) => {
        // Focus moving into the formatting bar keeps the box selected but ends typing.
        if (editing && !e.currentTarget.contains(e.relatedTarget as Node | null)) stopEditing();
      }}
      onKeyDown={(e) => {
        if (!editing) return;
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.stopPropagation();
          stopEditing();
        }
      }}
      onPaste={(e) => {
        // Paste as plain text everywhere (plaintext-only isn't universal).
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }}
    >
      {editing ? editStartText.current : obj.text}
      {selected && !editing && !readOnly && <div className="resize-handle" onPointerDown={onResizePointerDown} onDoubleClick={(e) => {
        e.stopPropagation();
        updateObject(obj.id, { wrapWidth: null });
      }} title="Drag to set the width; double-click to fit the text" contentEditable={false} />}
    </div>
  );
}

export const TextObjectView = memo(TextObjectViewImpl);
