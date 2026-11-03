import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CssBaseline from '@mui/material/CssBaseline';
import GlobalStyles from '@mui/material/GlobalStyles';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import { alpha, ThemeProvider } from '@mui/material/styles';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Typography from '@mui/material/Typography';
import { useEffect, useMemo } from 'react';
import { FormatBar } from './components/FormatBar';
import { MainToolbar } from './components/MainToolbar';
import { StatusBar } from './components/StatusBar';
import { TitleBar } from './components/TitleBar';
import { Viewer } from './components/Viewer';
import { Welcome } from './components/Welcome';
import { usePlatformIntegration } from './hooks/usePlatformIntegration';
import { useShortcuts } from './hooks/useShortcuts';
import { registerUnicodeFontFaces, resetFontMeasurements } from './lib/fonts';
import { listInstalledFaces } from './lib/installedFonts';
import { inTauri } from './platform/files';
import { dismissNotice, useEditor } from './state/store';
import { useActiveTheme, useThemeChoice } from './theme/themeChoice';
import { buildTheme } from './theme/themes';

function Notices() {
  const notice = useEditor((s) => s.notice);
  return (
    <Snackbar
      key={notice?.id}
      open={!!notice}
      autoHideDuration={notice?.severity === 'error' ? 8000 : 4000}
      onClose={(_, reason) => reason !== 'clickaway' && dismissNotice()}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ bottom: { xs: 48 } }}
    >
      {notice ? (
        <Alert severity={notice.severity} variant="filled" onClose={dismissNotice} sx={{ maxWidth: 560 }}>
          {notice.message}
        </Alert>
      ) : undefined}
    </Snackbar>
  );
}

function DropOverlay() {
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: 12,
        zIndex: 20,
        border: 3,
        borderStyle: 'dashed',
        borderColor: 'primary.main',
        borderRadius: 3,
        bgcolor: (t) => alpha(t.palette.primary.main, 0.08),
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <Typography variant="h6" color="primary">
        Drop a PDF to open it
      </Typography>
    </Box>
  );
}

function Editor() {
  const hasDoc = useEditor((s) => !!s.doc);
  const busy = useEditor((s) => s.busy);
  const dragging = usePlatformIntegration();
  useShortcuts();

  useEffect(() => {
    registerUnicodeFontFaces();
    // Load the installed font list early so matching fonts of existing text is instant.
    void listInstalledFaces();
    // Re-measure baselines once fonts are ready.
    void document.fonts?.ready.then(resetFontMeasurements);
  }, []);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {inTauri && <TitleBar />}
      <MainToolbar />
      {hasDoc && <FormatBar />}
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {busy && (
          <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }} aria-label={busy} />
        )}
        {hasDoc ? <Viewer /> : <Welcome />}
        {dragging && <DropOverlay />}
      </Box>
      {hasDoc && <StatusBar />}
      <Notices />
    </Box>
  );
}

function hexChannels(hex: string): string {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
}

export default function App() {
  const active = useActiveTheme();
  const followSystem = useThemeChoice((s) => s.choice === 'system');
  const theme = useMemo(() => buildTheme(active), [active]);

  useEffect(() => {
    document.documentElement.style.colorScheme = active.mode;
    if (inTauri) void getCurrentWindow().setTheme(followSystem ? null : active.mode).catch(() => {});
  }, [active.mode, followSystem]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <GlobalStyles
        styles={{
          ':root': {
            '--pe-accent': active.primary,
            '--pe-accent-rgb': hexChannels(active.primary),
            '--pe-surface': active.surface,
          },
        }}
      />
      <Editor />
    </ThemeProvider>
  );
}
