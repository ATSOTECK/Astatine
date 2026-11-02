import EditNoteIcon from '@mui/icons-material/EditNote';
import FolderOpenIcon from '@mui/icons-material/FolderOpenOutlined';
import StickyNote2Icon from '@mui/icons-material/StickyNote2Outlined';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { requestOpen } from '../hooks/useFileActions';
import { shortcut } from '../lib/keys';
import { useEditor } from '../state/store';

const FEATURES = [
  {
    icon: <EditNoteIcon color="primary" />,
    title: 'Edit the text that’s already there',
    body: 'Click any line, including text made by Word, Chrome or other apps, and type over it.',
  },
  {
    icon: <TextFieldsIcon color="primary" />,
    title: 'Add new text anywhere',
    body: 'Pick a font, size and colour, then click on the page and start typing.',
  },
  {
    icon: <StickyNote2Icon color="primary" />,
    title: 'Change text boxes from other editors',
    body: 'Text added in Preview, Acrobat, Firefox and others opens as editable boxes.',
  },
];

export function Welcome() {
  const busy = useEditor((s) => !!s.busy);
  return (
    <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', bgcolor: 'background.default', p: 3, overflow: 'auto' }}>
      <Paper variant="outlined" sx={{ p: { xs: 3, sm: 5 }, maxWidth: 560, width: '100%', textAlign: 'center', borderRadius: 3 }}>
        <Box component="img" src="/icon.svg" alt="" sx={{ width: 64, height: 64, mb: 2 }} />
        <Typography variant="h5" sx={{ fontWeight: 700 }} gutterBottom>
          PDF Editor
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Open a PDF to add text or change the text that’s already in it.
        </Typography>
        <Button
          variant="contained"
          size="large"
          disableElevation
          startIcon={<FolderOpenIcon />}
          onClick={() => void requestOpen()}
          disabled={busy}
        >
          Open PDF…
        </Button>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          {shortcut('O')} · or drop a PDF anywhere in this window
        </Typography>
        <Stack spacing={2} sx={{ mt: 4, textAlign: 'left' }}>
          {FEATURES.map((f) => (
            <Box key={f.title} sx={{ display: 'flex', gap: 1.5 }}>
              {f.icon}
              <Box>
                <Typography variant="subtitle2">{f.title}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {f.body}
                </Typography>
              </Box>
            </Box>
          ))}
        </Stack>
      </Paper>
    </Box>
  );
}
