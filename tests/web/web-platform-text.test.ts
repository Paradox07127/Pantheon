import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealText } from '../../apps/web/src/lib/platform-text';
import { zh } from './i18n-setup.js';

describe('file manager label', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['Macintosh; Intel Mac OS X 10_15_7', zh('lib.reveal.finder')],
    ['Windows NT 10.0; Win64; x64', zh('lib.reveal.explorer')],
    ['X11; Linux x86_64', zh('lib.reveal.fileManager')],
  ])('names the file manager of %s', (userAgent, label) => {
    vi.stubGlobal('navigator', { userAgent });
    expect(revealText()).toBe(label);
  });
});
