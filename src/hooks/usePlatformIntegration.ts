import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState } from 'react';
import { confirmDiscard, inTauri, openBrowserFile } from '../platform/files';
import { isDirty, showNotice, stopEditing, useEditor } from '../state/store';
import { requestOpenFile, requestOpenPath } from './useFileActions';

/**
 * Window title, unsaved-changes prompt on close, drag & drop, and files
 * opened from Finder/Explorer ("Open With", double-click, command line).
 * Returns whether a file is being dragged over the window.
 */
export function usePlatformIntegration(): boolean {
  const [dragging, setDragging] = useState(false);
  const name = useEditor((s) => s.doc?.name);
  const dirty = useEditor((s) => isDirty(s));

  useEffect(() => {
    const title = name ? `${dirty ? '• ' : ''}${name} — PDF Editor` : 'PDF Editor';
    if (inTauri) void getCurrentWindow().setTitle(title);
    else document.title = title;
  }, [name, dirty]);

  useEffect(() => {
    if (!inTauri) {
      const beforeUnload = (e: BeforeUnloadEvent) => {
        if (isDirty()) e.preventDefault();
      };
      const over = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      };
      const leave = (e: DragEvent) => {
        if (!e.relatedTarget) setDragging(false);
      };
      const drop = (e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name));
        if (file) void openBrowserFile(file).then(requestOpenFile);
        else if (e.dataTransfer?.files.length) showNotice('warning', 'Only PDF files can be opened.');
      };
      window.addEventListener('beforeunload', beforeUnload);
      window.addEventListener('dragover', over);
      window.addEventListener('dragleave', leave);
      window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('beforeunload', beforeUnload);
        window.removeEventListener('dragover', over);
        window.removeEventListener('dragleave', leave);
        window.removeEventListener('drop', drop);
      };
    }

    const cleanups: Promise<() => void>[] = [];
    const openPending = async () => {
      const paths = await invoke<string[]>('take_pending_files');
      const last = paths[paths.length - 1];
      if (last) await requestOpenPath(last);
    };
    void openPending();
    cleanups.push(listen('open-files', () => void openPending()));

    cleanups.push(
      getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') setDragging(true);
        else if (payload.type === 'leave') setDragging(false);
        else if (payload.type === 'drop') {
          setDragging(false);
          const pdf = payload.paths.find((p) => /\.pdf$/i.test(p));
          if (pdf) void requestOpenPath(pdf);
          else if (payload.paths.length) showNotice('warning', 'Only PDF files can be opened.');
        }
      }),
    );

    cleanups.push(
      getCurrentWindow().onCloseRequested(async (event) => {
        stopEditing();
        if (isDirty() && !(await confirmDiscard('You have unsaved changes. Close without saving?'))) {
          event.preventDefault();
        }
      }),
    );

    return () => {
      for (const c of cleanups) void c.then((fn) => fn());
    };
  }, []);

  return dragging;
}
