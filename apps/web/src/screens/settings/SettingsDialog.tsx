import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { SCREEN_NAMES } from '../../screens';
import { ProjectSettingsScreen } from './ProjectSettingsScreen';
import { useSettingsView } from './view';
import { scrimFlag } from '../../lib/root-flag';

/** The settings over the current screen; once opened, it stays mounted closed so unsaved drafts survive. */
export function SettingsDialog() {
  const open = useSettingsView((s) => s.open);
  const close = useSettingsView((s) => s.close);
  // Its pages read their data on mount, so nothing mounts before the first open.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal keepMounted>
        <Dialog.Backdrop className="ps-scrim" ref={scrimFlag} />
        <Dialog.Popup
          className="ps-frame"
          onKeyDown={(e) => {
            const target = e.target as HTMLElement;
            if (e.key !== '/' || target.closest('input, textarea, select, [contenteditable]'))
              return;
            e.preventDefault();
            e.currentTarget.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
          }}
        >
          <Dialog.Title className="ss-vh">{SCREEN_NAMES.settings}</Dialog.Title>
          <ProjectSettingsScreen />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
