import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import { useEffect, useState } from 'react';
import { shortcut } from '../lib/keys';
import { jumpToPage, useEditor } from '../state/store';

function hint(state: ReturnType<typeof useEditor.getState>): string {
  if (state.tool === 'select') {
    return `Drag across text to highlight it · ${shortcut('C')} copies · Press E to edit text, or T to add text`;
  }
  if (!state.doc?.editable) return 'This document is read-only.';
  if (state.editingId) return `Type to edit · Esc or click outside to finish · ${shortcut('B')} / ${shortcut('I')} for bold and italic`;
  if (state.tool === 'text') return 'Click on the page where the new text should start · Esc to cancel';
  if (state.selectedId) return 'Drag to move · Click again or press Enter to edit · Arrow keys nudge · Delete removes';
  return 'Click any text on the page to edit it · Press T, then click, to add new text · V to just select text';
}

export function StatusBar() {
  const text = useEditor(hint);
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 0);
  const currentPage = useEditor((s) => s.currentPage);
  const [draft, setDraft] = useState(String(currentPage + 1));
  useEffect(() => setDraft(String(currentPage + 1)), [currentPage]);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 2,
        height: 32,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        flexShrink: 0,
      }}
    >
      <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
        {text}
      </Typography>
      <IconButton size="small" disabled={currentPage <= 0} onClick={() => jumpToPage(currentPage - 1)} aria-label="Previous page">
        <NavigateBeforeIcon fontSize="small" />
      </IconButton>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        Page
        <InputBase
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = parseInt(draft, 10);
              if (n >= 1) jumpToPage(n - 1);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => setDraft(String(currentPage + 1))}
          inputProps={{ 'aria-label': 'Page number', style: { width: `${Math.max(2, String(pageCount).length)}ch`, textAlign: 'center', padding: 0 } }}
          sx={{ fontSize: 12, border: 1, borderColor: 'divider', borderRadius: 0.75, px: 0.5 }}
        />
        of {pageCount}
      </Typography>
      <IconButton
        size="small"
        disabled={currentPage >= pageCount - 1}
        onClick={() => jumpToPage(currentPage + 1)}
        aria-label="Next page"
      >
        <NavigateNextIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
