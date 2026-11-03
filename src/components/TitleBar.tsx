import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useState, type ReactNode } from 'react';
import { useWindowTitle } from '../hooks/usePlatformIntegration';
import { isMac } from '../lib/keys';
import { useActiveTheme } from '../theme/themeChoice';

const HEIGHT = isMac ? 28 : 32;
const TRAFFIC_LIGHTS_WIDTH = 78;
const BUTTON_WIDTH = 46;

interface WindowState {
  focused: boolean;
  maximized: boolean;
  fullscreen: boolean;
}

function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>({ focused: true, maximized: false, fullscreen: false });
  useEffect(() => {
    const win = getCurrentWindow();
    let active = true;
    const sync = async () => {
      const [focused, maximized, fullscreen] = await Promise.all([win.isFocused(), win.isMaximized(), win.isFullscreen()]);
      if (active) setState({ focused, maximized, fullscreen });
    };
    void sync();
    const listeners = [win.onResized(() => void sync()), win.onFocusChanged(() => void sync())];
    return () => {
      active = false;
      for (const l of listeners) void l.then((unlisten) => unlisten());
    };
  }, []);
  return state;
}

/** 10×10 outline glyphs, like the ones Windows draws. */
const GLYPHS = {
  minimize: <path d="M0 5.5h10" />,
  maximize: <rect x="0.5" y="0.5" width="9" height="9" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5v-2h7v7h-2" />
    </>
  ),
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
} satisfies Record<string, ReactNode>;

function WindowButton({ label, glyph, onClick, danger }: { label: string; glyph: ReactNode; onClick: () => void; danger?: boolean }) {
  const { titleBarText } = useActiveTheme();
  return (
    <ButtonBase
      aria-label={label}
      tabIndex={-1}
      onClick={onClick}
      sx={{
        width: BUTTON_WIDTH,
        height: '100%',
        color: 'inherit',
        transition: 'background-color 80ms',
        '&:hover': danger
          ? { bgcolor: 'error.main', color: 'error.contrastText' }
          : { bgcolor: alpha(titleBarText, 0.1) },
        '&:active': danger ? { bgcolor: (t) => alpha(t.palette.error.main, 0.8) } : { bgcolor: alpha(titleBarText, 0.18) },
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden>
        {glyph}
      </svg>
    </ButtonBase>
  );
}

export function TitleBar() {
  const theme = useActiveTheme();
  const title = useWindowTitle();
  const { focused, maximized, fullscreen } = useWindowState();
  if (fullscreen) {
    return null;
  }

  const win = getCurrentWindow();
  const inset = isMac ? TRAFFIC_LIGHTS_WIDTH : 3 * BUTTON_WIDTH;
  return (
    <Box
      data-tauri-drag-region="deep"
      sx={{
        position: 'relative',
        flexShrink: 0,
        height: HEIGHT,
        display: 'flex',
        justifyContent: 'flex-end',
        bgcolor: theme.titleBar,
        color: focused ? theme.titleBarText : alpha(theme.titleBarText, 0.5),
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      <Typography
        component="div"
        noWrap
        sx={{
          position: 'absolute',
          inset: 0,
          px: `${inset}px`,
          lineHeight: `${HEIGHT}px`,
          textAlign: 'center',
          fontSize: 13,
          fontWeight: 600,
          pointerEvents: 'none',
        }}
      >
        {title}
      </Typography>
      {!isMac && (
        <>
          <WindowButton label="Minimize" glyph={GLYPHS.minimize} onClick={() => void win.minimize()} />
          <WindowButton
            label={maximized ? 'Restore' : 'Maximize'}
            glyph={maximized ? GLYPHS.restore : GLYPHS.maximize}
            onClick={() => void win.toggleMaximize()}
          />
          <WindowButton label="Close" glyph={GLYPHS.close} onClick={() => void win.close()} danger />
        </>
      )}
    </Box>
  );
}
