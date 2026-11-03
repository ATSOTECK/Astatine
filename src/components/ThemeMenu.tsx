import CheckIcon from '@mui/icons-material/Check';
import PaletteIcon from '@mui/icons-material/PaletteOutlined';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import { useState } from 'react';
import { setThemeChoice, useThemeChoice } from '../theme/themeChoice';
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, type ThemeDefinition } from '../theme/themes';

function Swatch({ theme, split }: { theme: ThemeDefinition; split?: ThemeDefinition }) {
  const tile = (t: ThemeDefinition) => (
    <Box sx={{ flex: 1, bgcolor: t.backdrop, display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ height: 4, bgcolor: t.titleBar }} />
      <Box sx={{ height: 6, bgcolor: t.surface, borderBottom: `1px solid ${t.divider}` }} />
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
        <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: t.primary }} />
      </Box>
    </Box>
  );
  return (
    <Box
      sx={{
        width: 36,
        height: 26,
        borderRadius: 1,
        overflow: 'hidden',
        display: 'flex',
        border: 1,
        borderColor: 'divider',
        flexShrink: 0,
      }}
    >
      {tile(theme)}
      {split && tile(split)}
    </Box>
  );
}

export function ThemeMenu() {
  const choice = useThemeChoice((s) => s.choice);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pick = (id: string) => {
    setThemeChoice(id);
    setAnchor(null);
  };
  const item = (t: ThemeDefinition) => (
    <MenuItem key={t.id} selected={choice === t.id} onClick={() => pick(t.id)} sx={{ gap: 1.5 }}>
      <Swatch theme={t} />
      <ListItemText primary={t.name} />
      <ListItemIcon sx={{ justifyContent: 'flex-end', minWidth: 24 }}>
        {choice === t.id && <CheckIcon fontSize="small" />}
      </ListItemIcon>
    </MenuItem>
  );

  return (
    <>
      <Tooltip title="Theme">
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label="Theme">
          <PaletteIcon />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 240, maxHeight: '80vh' } } }}
      >
        <MenuItem selected={choice === 'system'} onClick={() => pick('system')} sx={{ gap: 1.5 }}>
          <Swatch theme={DEFAULT_LIGHT} split={DEFAULT_DARK} />
          <ListItemText primary="Match System" secondary="Light or Dark, like your computer" />
          <ListItemIcon sx={{ justifyContent: 'flex-end', minWidth: 24 }}>
            {choice === 'system' && <CheckIcon fontSize="small" />}
          </ListItemIcon>
        </MenuItem>
        <ListSubheader sx={{ lineHeight: '32px', bgcolor: 'background.paper' }}>Light</ListSubheader>
        {THEMES.filter((t) => t.mode === 'light').map(item)}
        <ListSubheader sx={{ lineHeight: '32px', bgcolor: 'background.paper' }}>Dark</ListSubheader>
        {THEMES.filter((t) => t.mode === 'dark').map(item)}
      </Menu>
    </>
  );
}
