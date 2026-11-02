import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { useMemo } from 'react';
import { cssFont } from '../lib/fonts';
import { useInstalledFamilies } from '../lib/installedFonts';
import type { FontFamily, TextStyle } from '../model/types';
import { normalizeName } from '../pdf/fontMatch';

interface FontOption {
  kind: 'standard' | 'installed';
  family: string;
}

const STANDARD: FontOption[] = (['Helvetica', 'Times', 'Courier'] as FontFamily[]).map((family) => ({ kind: 'standard', family }));

function previewFamily(option: FontOption): string {
  if (option.kind === 'standard') return cssFont({ family: option.family as FontFamily, bold: false, italic: false }, false).fontFamily;
  return `"${option.family}", system-ui`;
}

interface Props {
  style: TextStyle;
  disabled?: boolean;
  onChange: (patch: Partial<TextStyle>) => void;
}

/**
 * Font list: the three standard PDF fonts (no embedding needed) and every
 * font installed on this computer (embedded when saved).
 */
export function FontPicker({ style, disabled, onChange }: Props) {
  const families = useInstalledFamilies();
  const options = useMemo<FontOption[]>(
    () => [...STANDARD, ...families.map((family) => ({ kind: 'installed' as const, family }))],
    [families],
  );
  const value: FontOption = style.font
    ? (options.find((o) => o.kind === 'installed' && normalizeName(o.family) === normalizeName(style.font!.family)) ?? {
        kind: 'installed',
        family: style.font.family,
      })
    : STANDARD.find((o) => o.family === style.family)!;

  return (
    <Autocomplete
      size="small"
      disableClearable
      // Leave the field after choosing, so the next click selects the name for typing.
      blurOnSelect
      selectOnFocus
      handleHomeEndKeys
      disabled={disabled}
      options={options}
      value={value}
      groupBy={(o) => (o.kind === 'standard' ? 'Standard PDF fonts' : 'Installed fonts')}
      getOptionLabel={(o) => o.family}
      isOptionEqualToValue={(a, b) => a.kind === b.kind && a.family === b.family}
      onChange={(_, o) =>
        o.kind === 'standard' ? onChange({ family: o.family as FontFamily, font: undefined }) : onChange({ font: { family: o.family } })
      }
      renderOption={(props, o) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <li key={key} {...rest} style={{ ...rest.style, fontFamily: previewFamily(o) }}>
            {o.family}
          </li>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          placeholder="Font"
          slotProps={{
            ...params.slotProps,
            htmlInput: { ...params.slotProps.htmlInput, 'aria-label': 'Font', style: { fontFamily: previewFamily(value) } },
          }}
        />
      )}
      slotProps={{ listbox: { style: { maxHeight: 380 } }, popper: { style: { width: 280 }, placement: 'bottom-start' } }}
      sx={{ width: 210, '& .MuiInputBase-root': { py: '1px' } }}
    />
  );
}
