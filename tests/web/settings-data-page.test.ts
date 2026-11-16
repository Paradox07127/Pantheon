import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { t } from '@/i18n';
import { DataPage } from '@/screens/settings/DataPage';
import { Row, Section } from '@/screens/settings/ProjectSettingsScreen';

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const bridge = (dir: string) => ({
  daemon: vi.fn(async () => ({ ok: true as const, value: { data_dir: dir } })),
  revealPath: vi.fn(async () => ({ ok: true as const, value: null })),
});
const sections = (tree: unknown) => nodes(tree as never).filter((n) => n.type === Section);
const rows = (tree: unknown) => nodes(tree as never).filter((n) => n.type === Row);
const button = (tree: unknown) =>
  find(tree as never, (n) => n.type === 'button') as ReactElement<any>;

describe('data settings page', () => {
  it('shows the data folder as one named row with its path and a reveal button', async () => {
    const desk = bridge('/data/pantheon');
    vi.stubGlobal('window', { pantheon: desk });
    const h = mount(() => DataPage());
    await h.flush();
    const folder = find(h.value, (n) => n.props['data-setting-id'] === 'data.folder');
    expect(folder.props.className).toBe('ps-row');
    expect(text(find(folder, (n) => n.props.className === 'ps-row-nm'))).toBe(
      `${zh('settings.data.title')}/data/pantheon`,
    );
    const path = find(folder, (n) => text(n) === '/data/pantheon' && n.type === 'span');
    expect(path.props.className).toContain('dp-path');
    // The folder group has no caption over it.
    expect(sections(h.value).map((s) => s.props.title)).not.toContain(zh('settings.data.title'));

    const reveal = button(folder);
    expect(nodes(reveal).some((n) => typeof n.type !== 'string')).toBe(true);
    reveal.props.onClick();
    expect(desk.revealPath).toHaveBeenCalledWith('/data/pantheon');
  });

  it('keeps the reveal button off while the folder is still being read', () => {
    vi.stubGlobal('window', {
      pantheon: { daemon: () => new Promise(() => {}), revealPath: vi.fn() },
    });
    const h = mount(() => DataPage());
    const folder = find(h.value, (n) => n.props['data-setting-id'] === 'data.folder');
    expect(button(folder).props.disabled).toBe(true);
  });

  it('puts export and import on rows of their own under personal settings', () => {
    vi.stubGlobal('window', { pantheon: bridge('/d') });
    const page = mount(() => DataPage());
    const personal = named(page.value, 'PersonalSettings');
    const h = mount(() => (personal.type as () => ReactNode)());
    const section = find(h.value, (n) => n.type === Section);
    expect(section.props.title).toBe(zh('settings.data.personal'));
    expect(section.props.settingId).toBe('data.personal');
    const [exportRow, importRow] = rows(section);
    expect(exportRow!.props.label).toBe(zh('settings.data.exportRow'));
    expect(text(button(exportRow))).toBe(zh('settings.data.export'));
    expect(importRow!.props.label).toBe(zh('settings.data.importRow'));
    expect(text(button(importRow))).toBe(zh('settings.data.import'));
  });

  /** The diagnostics section, mounted on its own as the page draws it. */
  const mountDiagnostics = () => {
    const part = named(mount(() => DataPage()).value, 'Diagnostics');
    return mount(() => (part.type as () => ReactNode)());
  };
  const diagnostics = (tree: unknown) =>
    sections(tree).find((s) => s.props.title === zh('settings.data.diagnostics'))!;

  it('keeps the diagnostic log export off outside the desktop app', () => {
    vi.stubGlobal('window', {});
    const h = mountDiagnostics();
    const [log] = rows(diagnostics(h.value));
    expect(log!.props.label).toBe(zh('settings.data.diagnosticsLog'));
    expect(log!.props.settingId).toBe('data.diagnostics');
    expect(text(button(log))).toBe(zh('settings.data.export'));
    expect(button(log).props.disabled).toBe(true);
  });

  it('exports the diagnostic log through the desktop app, and a cancelled dialog leaves no error', async () => {
    const desk = {
      ...bridge('/d'),
      exportDiagnostics: vi.fn(async () => ({ ok: true as const, value: null })),
    };
    vi.stubGlobal('window', { pantheon: desk });
    const h = mountDiagnostics();
    const [log] = rows(diagnostics(h.value));
    expect(button(log).props.disabled).toBe(false);
    button(log).props.onClick();
    await h.flush();
    expect(desk.exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(nodes(diagnostics(h.value)).some((n) => n.props.role === 'alert')).toBe(false);
  });

  it('shows a failed export under its row', async () => {
    const desk = {
      ...bridge('/d'),
      exportDiagnostics: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'export_failed', message: 'EACCES: permission denied' },
      })),
    };
    vi.stubGlobal('window', { pantheon: desk });
    const h = mountDiagnostics();
    button(rows(diagnostics(h.value))[0]).props.onClick();
    await h.flush();
    const alert = find(diagnostics(h.value), (n) => n.props.role === 'alert');
    expect(text(alert)).toBe(
      t(
        { id: 'settings.data.diagnosticsFailed', defaultMessage: '' },
        { message: 'EACCES: permission denied' },
      ),
    );
    expect(alert.props.className).toBe('ps-err dp-err');
  });
});
