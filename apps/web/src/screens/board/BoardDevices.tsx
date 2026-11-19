import type { CSSProperties } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Terminal } from 'lucide-react';
import type { DeviceListItem } from '@pantheon/protocol';
import { useDevices } from '../../data/devices';
import { t } from '../../i18n';
import './devices.css';

const isLocal = (d: DeviceListItem) => d.id === 'local';

export const deviceName = (d: DeviceListItem) =>
  !isLocal(d)
    ? d.name
    : d.os === 'macos'
      ? t({ id: 'settings.devices.thisMac', defaultMessage: 'This Mac' })
      : t({ id: 'settings.devices.thisComputer', defaultMessage: 'This computer' });

const offlineText = () => t({ id: 'settings.devices.offline', defaultMessage: "Can't connect" });

/** A status dot: filled when good, a hollow ring when not, so the shape tells them apart too. */
export function DeviceDot({ ok, label }: { ok: boolean; label: string }) {
  return <span className="bdv-dot" data-s={ok ? 'ok' : 'bad'} role="img" aria-label={label} />;
}

export function DeviceState({ device }: { device: DeviceListItem }) {
  return (
    <DeviceDot
      ok={device.online}
      label={
        device.online
          ? t({ id: 'settings.devices.online', defaultMessage: 'Online' })
          : offlineText()
      }
    />
  );
}

/** What the last probe found of the device's system; that it cannot connect when it is offline. */
export function DeviceFacts({ device: d }: { device: DeviceListItem }) {
  if (!d.online) return <span className="bdv-sys">{offlineText()}</span>;
  const facts = [
    d.os === 'macos'
      ? ['macOS', d.os_version].filter(Boolean).join(' ')
      : (d.os_version ?? (d.os === 'linux' ? 'Linux' : undefined)),
    d.arch,
    d.cpus !== undefined &&
      t(
        {
          id: 'settings.devices.cores',
          defaultMessage: '{count, plural, one {# core} other {# cores}}',
        },
        { count: d.cpus },
      ),
  ];
  return (
    <span className="bdv-sys">
      {facts.map((fact, i) => (fact ? <span key={i}>{fact}</span> : null))}
    </span>
  );
}

/** How much of one of the device's resources unfinished tasks use, as a bar and a count. */
export function ResourceMeter({ device, resource }: { device: DeviceListItem; resource: string }) {
  const total = device.resources[resource] ?? 0;
  const used = device.load.uses[resource] ?? 0;
  return (
    <>
      <span
        className="meter bdv-meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        aria-label={t(
          {
            id: 'board.devices.resourceUse',
            defaultMessage: '{resource} on {device}: {used} of {total} in use',
          },
          { resource, device: deviceName(device), used, total },
        )}
        data-full={used >= total || undefined}
      >
        <i style={{ '--v': `${total ? Math.min(used / total, 1) * 100 : 0}%` } as CSSProperties} />
      </span>
      <span className="bdv-n">{`${used} / ${total}`}</span>
    </>
  );
}

const sessionsText = (d: DeviceListItem) =>
  isLocal(d)
    ? t(
        {
          id: 'board.devices.sessions',
          defaultMessage: '{count, plural, one {# session} other {# sessions}}',
        },
        { count: d.load.sessions },
      )
    : t(
        { id: 'board.devices.sessionsOf', defaultMessage: '{used} / {max} sessions' },
        { used: d.load.sessions, max: d.max_sessions },
      );

/** The agents' device summary: how many devices are online, and each device's state and load. */
export function BoardDevices() {
  const { read, reload } = useDevices();
  if (read.state !== 'ready') return null;
  const online = read.devices.filter((d) => d.online).length;
  const label = t({ id: 'board.devices.title', defaultMessage: 'Devices' });
  const summary = t(
    {
      id: 'board.devices.summary',
      defaultMessage: 'Devices, {online} of {total} online',
    },
    { online, total: read.devices.length },
  );
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) void reload(false);
      }}
    >
      <Popover.Trigger className="btn sm ghost bdv-tg" aria-label={summary}>
        <Terminal aria-hidden="true" />
        {t(
          {
            id: 'board.devices.online',
            defaultMessage: '{count, plural, one {# device online} other {# devices online}}',
          },
          { count: online },
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
          <Popover.Popup className="pop bdv-pop" aria-label={label}>
            <ul className="bdv-l">
              {read.devices.map((d) => (
                <li key={d.id} className="bdv-d">
                  <div className="bdv-h">
                    <DeviceState device={d} />
                    <b className="bdv-nm">{deviceName(d)}</b>
                    <span className="bdv-n">{d.online ? sessionsText(d) : offlineText()}</span>
                  </div>
                  {d.online &&
                    Object.keys(d.resources).map((resource) => (
                      <div key={resource} className="bdv-use">
                        <span className="mono">{resource}</span>
                        <ResourceMeter device={d} resource={resource} />
                      </div>
                    ))}
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
