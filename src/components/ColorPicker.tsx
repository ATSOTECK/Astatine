import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Popover from '@mui/material/Popover';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import type { RGB } from '../model/types';
import { cssHex } from '../pdf/freeText';

const PALETTE = [
  '#000000', '#404040', '#7f7f7f', '#bfbfbf', '#ffffff',
  '#c00000', '#e8590c', '#f2c200', '#2b8a3e', '#1971c2',
  '#3b5bdb', '#7048e8', '#c2255c', '#5c3d2e', '#0b7285',
];

function parseHex(hex: string): RGB {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
}

function Swatch({ color, selected, onClick, size = 22 }: { color: string; selected?: boolean; onClick?: () => void; size?: number }) {
  return (
    <ButtonBase
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={color}
      sx={{
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: color,
        border: 1,
        borderColor: 'divider',
        outline: selected ? '2px solid' : 'none',
        outlineColor: 'primary.main',
        outlineOffset: 2,
      }}
    />
  );
}

interface Props {
  label: string;
  value: RGB;
  onChange: (color: RGB) => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}

export function ColorPicker({ label, value, onChange, disabled, icon }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hex = cssHex(value).toLowerCase();
  return (
    <>
      <Tooltip title={label}>
        <span>
          <ButtonBase
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => setAnchor(e.currentTarget)}
            sx={{ px: 0.75, py: 0.5, borderRadius: 1, gap: 0.5, opacity: disabled ? 0.4 : 1, '&:hover': { bgcolor: 'action.hover' } }}
          >
            {icon}
            <Box sx={{ width: 18, height: 18, borderRadius: 0.75, bgcolor: hex, border: 1, borderColor: 'divider' }} />
          </ButtonBase>
        </span>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        disableAutoFocus
        disableRestoreFocus
      >
        <Box sx={{ p: 1.5, display: 'grid', gridTemplateColumns: 'repeat(5, 22px)', gap: 1.25 }}>
          {PALETTE.map((c) => (
            <Swatch key={c} color={c} selected={c === hex} onClick={() => (onChange(parseHex(c)), setAnchor(null))} />
          ))}
        </Box>
        <Box
          component="label"
          sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pb: 1.5, cursor: 'pointer' }}
        >
          <input
            type="color"
            value={hex}
            onChange={(e) => onChange(parseHex(e.target.value))}
            style={{ width: 28, height: 22, padding: 0, border: 'none', background: 'none' }}
          />
          <Typography variant="body2">Custom…</Typography>
        </Box>
      </Popover>
    </>
  );
}
