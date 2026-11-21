import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { App } from './App';
import { watchSystemAccent } from './data/layout';
import { startLocale } from './i18n';
import { MenuActions } from './lib/menu-actions';
import { CrashNotice } from './shell/CrashNotice';
import { MiniWindow } from './shell/MiniWindow';
import { QuitDialog } from './shell/QuitDialog';
import { ConnectionGate, RecoverBoundary } from './shell/RecoverScreen';
import { TrayPopover } from './shell/TrayPopover';
import { FirstContent, refuseStrayFiles } from './shell/window-kind';
import { useShell } from './store';
import './index.css';

window.pantheon?.setThemeSource(useShell.getState().theme);
useShell.subscribe((state, before) => {
  if (state.theme !== before.theme) window.pantheon?.setThemeSource(state.theme);
});
window.addEventListener('dragover', refuseStrayFiles);
window.addEventListener('drop', refuseStrayFiles);
watchSystemAccent();

// Text drawn before its font has loaded moves when the font swaps in.
await Promise.all([
  startLocale(),
  Promise.race([
    Promise.all([
      document.fonts.load('13px "Geist Variable"'),
      document.fonts.load('13px "Geist Mono Variable"'),
    ]),
    new Promise((done) => setTimeout(done, 300)),
  ]),
]);

// The desktop app hides the title bar and draws the window buttons over the top bar.
if (window.pantheon) {
  document.documentElement.classList.add(
    navigator.userAgent.includes('Mac') ? 'mac-titlebar' : 'overlay-titlebar',
  );
}

const kind = window.pantheon?.windowContext().kind ?? 'main';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {(kind === 'main' || kind === 'project') && <FirstContent />}
    <RecoverBoundary>
      {kind === 'popover' ? (
        <TrayPopover />
      ) : kind === 'mini' ? (
        <MiniWindow />
      ) : (
        <>
          <ConnectionGate>
            <App />
          </ConnectionGate>
          <MenuActions />
          {kind === 'main' && <QuitDialog />}
          {kind === 'main' && <CrashNotice />}
        </>
      )}
    </RecoverBoundary>
  </StrictMode>,
);
