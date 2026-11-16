import { describe, expect, it } from 'vitest';
import { defaultDataDirectory, defaultDesktopUserDataDirectory } from '@pantheon/protocol/paths';

const home = '/home/someone';

describe('default data directories', () => {
  it('keeps the Application Support folders on macOS', () => {
    expect(defaultDataDirectory('darwin', {}, '/Users/someone')).toBe(
      '/Users/someone/Library/Application Support/Pantheon',
    );
    expect(defaultDesktopUserDataDirectory('darwin', {}, '/Users/someone')).toBe(
      '/Users/someone/Library/Application Support/Pantheon Desktop',
    );
  });

  it('uses the XDG fallbacks on Linux when the XDG variables are unset', () => {
    expect(defaultDataDirectory('linux', {}, home)).toBe(
      '/home/someone/.local/share/pantheon/data',
    );
    expect(defaultDesktopUserDataDirectory('linux', {}, home)).toBe(
      '/home/someone/.config/Pantheon Desktop',
    );
  });

  it('follows XDG_DATA_HOME and XDG_CONFIG_HOME on Linux', () => {
    const env = { XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' };
    expect(defaultDataDirectory('linux', env, home)).toBe('/xdg/data/pantheon/data');
    expect(defaultDesktopUserDataDirectory('linux', env, home)).toBe(
      '/xdg/config/Pantheon Desktop',
    );
  });

  it('takes the desktop folder from PANTHEON_DESKTOP_DATA_DIR on Linux', () => {
    const env = {
      PANTHEON_DESKTOP_DATA_DIR: '/mnt/c/Users/someone/AppData/Roaming/Pantheon Desktop',
      XDG_CONFIG_HOME: '/xdg/config',
    };
    expect(defaultDesktopUserDataDirectory('linux', env, home)).toBe(
      '/mnt/c/Users/someone/AppData/Roaming/Pantheon Desktop',
    );
  });
});
