import { describe, expect, it, vi } from 'vitest';
import { resolveWslFile } from '../../apps/desktop/src/main/open-target.js';

// open-target resolves through the distro's Windows share with Windows path rules.
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  const windows = { ...actual.win32, posix: actual.posix };
  return { ...windows, default: windows };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const fs = {
    ...actual,
    realpathSync: (file: string) => file,
    statSync: () => ({ isFile: () => true }),
    existsSync: () => true,
  };
  return { ...fs, default: fs };
});

describe('opening a WSL file from Windows', () => {
  it('keeps a file in a folder differing from the root only in case outside the root', () => {
    expect(resolveWslFile({ path: '/home/u/project/secret' }, ['/home/u/Project'], 'Ubuntu')).toBe(
      null,
    );
    expect(resolveWslFile({ path: '/home/u/Project/a.txt' }, ['/home/u/Project'], 'Ubuntu')).toBe(
      '/home/u/Project/a.txt',
    );
  });

  it('finds names that start with two dots inside the root', () => {
    expect(resolveWslFile({ path: '..config' }, ['/home/u/p'], 'Ubuntu')).toBe(
      '/home/u/p/..config',
    );
    expect(resolveWslFile({ path: '/home/u/p/..assets/a.txt' }, ['/home/u/p'], 'Ubuntu')).toBe(
      '/home/u/p/..assets/a.txt',
    );
  });

  it('refuses a target or root with a backslash, which the share would read as a separator', () => {
    expect(resolveWslFile({ path: '/home/u/p/a\\b' }, ['/home/u/p'], 'Ubuntu')).toBe(null);
    expect(resolveWslFile({ path: 'a\\b' }, ['/home/u/p'], 'Ubuntu')).toBe(null);
    expect(resolveWslFile({ path: '/home/u/p/q/a.txt' }, ['/home/u/p\\q'], 'Ubuntu')).toBe(null);
  });
});
