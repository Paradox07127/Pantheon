import { useLayoutEffect, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Terminal } from 'lucide-react';
import type { BoardSnapshot, DeviceListItem } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { useDevices } from '../data/devices';
import { sessionTitle } from '../data/transcript';
import { t } from '../i18n';
import { holdRootFlag } from '../lib/root-flag';
import { RuntimeGlyph, runtimeName } from './RuntimeGlyph';
import { useSettingsView } from '../screens/settings/view';
import { useShell } from '../store';
import './devices-summary.css';

const isLocal = (d: DeviceListItem) => d.id === 'local';

export const deviceName = (d: DeviceListItem) =>
  !isLocal(d)
    ? d.name
    : d.os === 'macos'
      ? t({ id: 'settings.devices.thisMac', defaultMessage: 'This Mac' })
      : t({ id: 'settings.devices.thisComputer', defaultMessage: 'This computer' });

export const offlineText = () =>
  t({ id: 'settings.devices.offline', defaultMessage: "Can't connect" });

export const systemName = (d: DeviceListItem) =>
  d.os === 'macos'
    ? ['macOS', d.os_version].filter(Boolean).join(' ')
    : (d.os_version ?? (d.os === 'linux' ? 'Linux' : undefined));

export const coresText = (d: DeviceListItem) =>
  d.cpus !== undefined &&
  t(
    {
      id: 'settings.devices.cores',
      defaultMessage: '{count, plural, one {# core} other {# cores}}',
    },
    { count: d.cpus },
  );

/** A status dot: filled when online, a hollow ring when not, so the shape tells them apart too. */
const deviceState = (device: DeviceListItem) => (
  <span
    className="dvs-dot"
    data-s={device.online ? 'ok' : 'bad'}
    role="img"
    aria-label={
      device.online ? t({ id: 'settings.devices.online', defaultMessage: 'Online' }) : offlineText()
    }
  />
);

/** What the last probe found of an online device's system. */
const deviceFacts = (d: DeviceListItem) => (
  <span className="dvs-sys">
    {[systemName(d), d.arch, coresText(d)].map((fact, i) =>
      fact ? <span key={i}>{fact}</span> : null,
    )}
  </span>
);

const sessionsText = (d: DeviceListItem) =>
  t(
    {
      id: 'components.devicesSummary.sessions',
      defaultMessage: '{count, plural, one {# session} other {# sessions}}',
    },
    { count: d.load.active_sessions.length },
  );

const SHOWN_SESSIONS = 3;

/** The sessions running on an online device, each opening its session, the rest only counted. */
const deviceSessions = (d: DeviceListItem, board: BoardSnapshot | null, onOpen: () => void) => {
  const all = d.load.active_sessions;
  if (!all.length) return null;
  return (
    <div className="dvs-ss">
      {all.slice(0, SHOWN_SESSIONS).map((s) => {
        // The device runs sessions of every project; this window's board names their project.
        const session = board?.sessions.find((each) => each.id === s.id);
        return (
          <button
            key={s.id}
            type="button"
            className="dvs-s"
            onClick={() => {
              onOpen();
              if (session) useShell.getState().openProjectSession(session.project_id, s.id);
              else useShell.getState().openSession(s.id);
            }}
          >
            <RuntimeGlyph runtime={s.runtime} size={14} />
            <span className="dvs-st">
              {session && board ? sessionTitle(session, board) : s.title}
            </span>
            <span className="dvs-rt">{runtimeName(s.runtime)}</span>
          </button>
        );
      })}
      {all.length > SHOWN_SESSIONS && (
        <span className="dvs-more">
          {t(
            { id: 'components.devicesSummary.more', defaultMessage: '{count} more' },
            { count: all.length - SHOWN_SESSIONS },
          )}
        </span>
      )}
    </div>
  );
};

/** The title bar's device summary: how many devices are online, and each device's state and load. */
export function DevicesSummary() {
  const { read, reload } = useDevices();
  const board = useBoard((s) => s.board);
  const [open, setOpen] = useState(false);
  // This machine alone has nothing to compare against.
  const shown = read.state === 'ready' && read.devices.length > 1;
  // The page bars in the title bar end where these controls begin (title-bar-end.css).
  useLayoutEffect(() => (shown ? holdRootFlag('title-devices') : undefined), [shown]);
  if (!shown) return null;
  const online = read.devices.filter((d) => d.online).length;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void reload(false);
      }}
    >
      <Popover.Trigger
        className="btn sm ghost tbe-dev"
        aria-label={t(
          {
            id: 'components.devicesSummary.summary',
            defaultMessage: 'Devices, {online} of {total} online',
          },
          { online, total: read.devices.length },
        )}
      >
        <Terminal className="ic-sm" aria-hidden="true" />
        {online}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Popover.Popup
            className="pop dvs-pop"
            aria-label={t({ id: 'components.devicesSummary.title', defaultMessage: 'Devices' })}
          >
            <ul className="dvs-l">
              {read.devices.map((d) => (
                <li key={d.id} className="dvs-d">
                  <div className="dvs-h">
                    {deviceState(d)}
                    <b className="dvs-nm">{deviceName(d)}</b>
                    <span className="dvs-n">{d.online ? sessionsText(d) : offlineText()}</span>
                  </div>
                  {d.online && deviceFacts(d)}
                  {d.online && deviceSessions(d, board, () => setOpen(false))}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn ghost sm dvs-set"
              onClick={() => {
                setOpen(false);
                useSettingsView.getState().setPage('devices');
                useShell.getState().openSettings(null);
              }}
            >
              {t({ id: 'components.devicesSummary.settings', defaultMessage: 'Device settings' })}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
