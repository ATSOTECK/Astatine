import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatColorFillIcon from '@mui/icons-material/FormatColorFill';
import FormatColorTextIcon from '@mui/icons-material/FormatColorText';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import InfoIcon from '@mui/icons-material/InfoOutlined';
import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import { displayFont } from '../lib/fonts';
import { useInstalledFont } from '../lib/installedFonts';
import { shortcut } from '../lib/keys';
import type { RGB } from '../model/types';
import { unencodableCharacters } from '../pdf/standardFonts';
import { deleteObject, objectById, updateObject, updateStyle, useEditor } from '../state/store';
import { ColorPicker } from './ColorPicker';
import { FontPicker } from './FontPicker';

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72];

/** Keeps focus in the text being edited when clicking a formatting button. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function FontSizeField({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value]);
  const commit = () => {
    const n = parseFloat(draft);
    if (n > 0 && n <= 1000) onChange(n);
    else setDraft(String(value));
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center' }}>
      <TextField
        size="small"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const next = Math.max(1, Math.round(value) + (e.key === 'ArrowUp' ? 1 : -1));
            onChange(next);
          }
        }}
        slotProps={{ htmlInput: { 'aria-label': 'Font size', inputMode: 'decimal', style: { width: 36, textAlign: 'right' } } }}
        sx={{ '& .MuiInputBase-input': { py: 0.6 } }}
      />
      <Select
        size="small"
        value=""
        displayEmpty
        disabled={disabled}
        renderValue={() => 'pt'}
        onChange={(e) => onChange(Number(e.target.value))}
        sx={{ ml: 0.5, '& .MuiSelect-select': { py: 0.6, pr: '28px !important', pl: 1 } }}
        MenuProps={{ disableAutoFocusItem: true, slotProps: { paper: { sx: { maxHeight: 320 } } } }}
      >
        {SIZES.map((s) => (
          <MenuItem key={s} value={s} selected={s === value}>
            {s}
          </MenuItem>
        ))}
      </Select>
    </Box>
  );
}

export function FormatBar() {
  const selectedId = useEditor((s) => s.selectedId);
  const selected = useEditor((s) => (s.selectedId ? s.current?.objects.find((o) => o.id === s.selectedId) : undefined));
  const defaultStyle = useEditor((s) => s.defaultStyle);
  const selectMode = useEditor((s) => s.tool === 'select');
  // Nothing can be changed in Select mode.
  const editable = useEditor((s) => !!s.doc?.editable && s.tool !== 'select');
  const style = selected?.style ?? defaultStyle;
  const installed = useInstalledFont(style.font, style.bold, style.italic);
  const shown = selected ? displayFont(selected.style, selected.text, installed) : null;
  const fontName = style.font?.family ?? style.family;
  const missingSource = selected?.sourceFont && !selected.sourceFont.matched ? selected.sourceFont.name : null;

  const setBackground = (bg: RGB | null) => {
    const obj = objectById(selectedId);
    if (obj) updateObject(obj.id, { background: bg });
  };

  return (
    <Toolbar
      variant="dense"
      sx={{ gap: 1, minHeight: 46, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexWrap: 'wrap' }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 92 }}>
        {selectMode ? 'Select mode' : selected ? (selected.kind === 'content' ? 'Page text' : 'Text box') : 'New text'}
      </Typography>

      <FontPicker style={style} disabled={!editable} onChange={updateStyle} />

      <FontSizeField value={style.size} disabled={!editable} onChange={(size) => updateStyle({ size })} />

      <Box sx={{ display: 'flex', gap: 0.25 }}>
        <Tooltip title={`Bold (${shortcut('B')})`}>
          <ToggleButton
            value="bold"
            size="small"
            selected={style.bold}
            disabled={!editable}
            onMouseDown={keepFocus}
            onChange={() => updateStyle({ bold: !style.bold })}
            sx={{ border: 0 }}
          >
            <FormatBoldIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Tooltip title={`Italic (${shortcut('I')})`}>
          <ToggleButton
            value="italic"
            size="small"
            selected={style.italic}
            disabled={!editable}
            onMouseDown={keepFocus}
            onChange={() => updateStyle({ italic: !style.italic })}
            sx={{ border: 0 }}
          >
            <FormatItalicIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
      </Box>

      <ColorPicker
        label="Text color"
        value={style.color}
        disabled={!editable}
        icon={<FormatColorTextIcon fontSize="small" />}
        onChange={(color) => updateStyle({ color })}
      />

      <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

      <Tooltip title="White background (covers what's underneath)">
        <span>
          <ToggleButton
            value="background"
            size="small"
            selected={!!selected?.background}
            disabled={!selected}
            onMouseDown={keepFocus}
            onChange={() => setBackground(selected?.background ? null : [1, 1, 1])}
            sx={{ border: 0 }}
          >
            <FormatColorFillIcon fontSize="small" />
          </ToggleButton>
        </span>
      </Tooltip>
      {selected?.background && (
        <ColorPicker label="Background color" value={selected.background} onChange={(c) => setBackground(c)} />
      )}

      <Box sx={{ flex: 1 }} />

      {missingSource && (
        <Tooltip
          title={`The original font “${missingSource}” isn’t installed on this computer, so the font chosen in the font list (${fontName}) is used. Pick any font to change it.`}
        >
          <Chip size="small" color="warning" icon={<WarningIcon />} label="Original font not installed" variant="outlined" />
        </Tooltip>
      )}
      {shown?.installedMissing && !missingSource && (
        <Tooltip title={`“${fontName}” isn’t available on this computer, so ${style.family} is used.`}>
          <Chip size="small" color="warning" icon={<WarningIcon />} label="Font not available" variant="outlined" />
        </Tooltip>
      )}
      {shown?.unicodeFallback && selected && (
        <Tooltip
          title={`${style.font ? `“${fontName}” doesn't include` : "The standard PDF fonts can't show"} ${
            unencodableCharacters(selected.text).slice(0, 8).join(' ') || 'some of these characters'
          }, so this text uses Liberation Sans (embedded in the file).`}
        >
          <Chip size="small" icon={<InfoIcon />} label="Unicode font" variant="outlined" />
        </Tooltip>
      )}

      <Tooltip title="Delete text (Delete)">
        <span>
          <IconButton size="small" disabled={!selected} onMouseDown={keepFocus} onClick={() => selected && deleteObject(selected.id)}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Toolbar>
  );
}
