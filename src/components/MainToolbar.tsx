import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import EditNoteIcon from '@mui/icons-material/EditNote';
import HighlightAltIcon from '@mui/icons-material/HighlightAlt';
import FolderOpenIcon from '@mui/icons-material/FolderOpenOutlined';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import RedoIcon from '@mui/icons-material/Redo';
import SaveIcon from '@mui/icons-material/SaveOutlined';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import UndoIcon from '@mui/icons-material/Undo';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { requestOpen } from '../hooks/useFileActions';
import { ThemeMenu } from './ThemeMenu';
import { shortcut } from '../lib/keys';
import { fitWidth, isDirty, redo, save, setTool, setZoom, undo, useEditor, zoomStep, ZOOM_STEPS, type Tool } from '../state/store';

export function MainToolbar() {
  const doc = useEditor((s) => s.doc);
  const dirty = useEditor((s) => isDirty(s));
  const canUndo = useEditor((s) => s.undoStack.length > 0);
  const canRedo = useEditor((s) => s.redoStack.length > 0);
  const tool = useEditor((s) => s.tool);
  const zoom = useEditor((s) => s.zoom);
  const fit = useEditor((s) => s.fitWidth);
  const busy = useEditor((s) => !!s.busy);
  const [saveMenu, setSaveMenu] = useState<HTMLElement | null>(null);
  const [zoomMenu, setZoomMenu] = useState<HTMLElement | null>(null);
  const editable = !!doc?.editable;

  return (
    <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" sx={{ gap: 1, minHeight: 52 }}>
        <PictureAsPdfIcon color="primary" />
        <Box sx={{ minWidth: 0, mr: 1, display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600, maxWidth: 280 }} title={doc?.path ?? doc?.name}>
            {doc ? doc.name : 'Astatine'}
          </Typography>
          {dirty && (
            <Typography variant="caption" color="text.secondary" noWrap>
              Edited
            </Typography>
          )}
        </Box>

        <Tooltip title={`Open… (${shortcut('O')})`}>
          <Button startIcon={<FolderOpenIcon />} onClick={() => void requestOpen()} disabled={busy} color="inherit">
            Open
          </Button>
        </Tooltip>
        <ButtonGroup variant="contained" disableElevation size="small" disabled={!editable || busy}>
          <Tooltip title={`Save (${shortcut('S')})`}>
            <Button startIcon={<SaveIcon />} onClick={() => void save('save')}>
              Save
            </Button>
          </Tooltip>
          <Button aria-label="More save options" onClick={(e) => setSaveMenu(e.currentTarget)} sx={{ px: 0.25, minWidth: 0 }}>
            <ArrowDropDownIcon fontSize="small" />
          </Button>
        </ButtonGroup>
        <Menu anchorEl={saveMenu} open={!!saveMenu} onClose={() => setSaveMenu(null)}>
          <MenuItem onClick={() => (setSaveMenu(null), void save('save'))}>
            <ListItemText primary="Save" secondary="Text boxes stay editable in other apps" />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
              {shortcut('S')}
            </Typography>
          </MenuItem>
          <MenuItem onClick={() => (setSaveMenu(null), void save('saveAs'))}>
            <ListItemText primary="Save As…" />
            <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
              {shortcut('S', true)}
            </Typography>
          </MenuItem>
          <Divider />
          <MenuItem onClick={() => (setSaveMenu(null), void save('flattenedCopy'))}>
            <ListItemText primary="Save Flattened Copy…" secondary="Writes all text into the pages themselves" />
          </MenuItem>
        </Menu>

        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Tooltip title={`Undo (${shortcut('Z')})`}>
          <span>
            <IconButton onClick={undo} disabled={!canUndo || busy} size="small">
              <UndoIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={`Redo (${shortcut('Z', true)})`}>
          <span>
            <IconButton onClick={redo} disabled={!canRedo || busy} size="small">
              <RedoIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />

        <ToggleButtonGroup
          size="small"
          exclusive
          value={tool}
          disabled={!doc}
          onChange={(_, value: Tool | null) => value && setTool(value)}
        >
          <Tooltip title="Select: highlight and copy text without changing anything (V)">
            <ToggleButton value="select" aria-label="Select text">
              <HighlightAltIcon fontSize="small" sx={{ mr: 0.5 }} />
              Select
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Edit: click any text to change it, drag boxes to move (E)">
            <ToggleButton value="edit" aria-label="Edit text" disabled={!editable}>
              <EditNoteIcon fontSize="small" sx={{ mr: 0.5 }} />
              Edit
            </ToggleButton>
          </Tooltip>
          <Tooltip title="Add text: click on the page to type (T)">
            <ToggleButton value="text" aria-label="Add text" disabled={!editable}>
              <TextFieldsIcon fontSize="small" sx={{ mr: 0.5 }} />
              Add Text
            </ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>

        <Box sx={{ flex: 1 }} />

        {doc && (
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Tooltip title={`Zoom out (${shortcut('−')})`}>
              <IconButton size="small" onClick={() => zoomStep(-1)}>
                <ZoomOutIcon />
              </IconButton>
            </Tooltip>
            <Button color="inherit" onClick={(e) => setZoomMenu(e.currentTarget)} sx={{ minWidth: 64 }}>
              {Math.round(zoom * 100)}%
            </Button>
            <Menu anchorEl={zoomMenu} open={!!zoomMenu} onClose={() => setZoomMenu(null)}>
              <MenuItem selected={fit} onClick={() => (setZoomMenu(null), fitWidth())}>
                Fit Width
              </MenuItem>
              <Divider />
              {ZOOM_STEPS.filter((z) => z >= 0.5).map((z) => (
                <MenuItem key={z} selected={!fit && Math.abs(z - zoom) < 0.001} onClick={() => (setZoomMenu(null), setZoom(z))}>
                  {Math.round(z * 100)}%
                </MenuItem>
              ))}
            </Menu>
            <Tooltip title={`Zoom in (${shortcut('+')})`}>
              <IconButton size="small" onClick={() => zoomStep(1)}>
                <ZoomInIcon />
              </IconButton>
            </Tooltip>
          </Box>
        )}
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <ThemeMenu />
      </Toolbar>
    </AppBar>
  );
}
