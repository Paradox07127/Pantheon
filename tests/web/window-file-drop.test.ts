import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refuseStrayFiles } from '@/shell/window-kind';

const web = path.resolve(import.meta.dirname, '../../apps/web');
const read = (file: string) => readFileSync(path.join(web, file), 'utf8');

function drag(type: string, types: string[], defaultPrevented = false) {
  const event = {
    type,
    defaultPrevented,
    preventDefault: vi.fn(),
    dataTransfer: { types, dropEffect: 'copy' },
  };
  refuseStrayFiles(event as unknown as DragEvent);
  return event;
}

describe('the window', () => {
  it('turns spelling checks off for every field that does not turn them on', () => {
    expect(read('index.html')).toMatch(/<body[^>]*\sspellcheck="false"/);
  });

  it('refuses files dragged where no drop zone takes them, so the page does not open them', () => {
    const over = drag('dragover', ['Files']);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('none');
    expect(drag('drop', ['Files']).preventDefault).toHaveBeenCalled();
  });

  it('leaves files a drop zone took and drags of anything but files alone', () => {
    const taken = drag('dragover', ['Files'], true);
    expect(taken.preventDefault).not.toHaveBeenCalled();
    expect(taken.dataTransfer.dropEffect).toBe('copy');
    for (const type of ['dragover', 'drop']) {
      const moved = drag(type, ['text/plain']);
      expect(moved.preventDefault).not.toHaveBeenCalled();
      expect(moved.dataTransfer.dropEffect).toBe('copy');
    }
  });

  it('listens for both drag events on the whole window', () => {
    const main = read('src/main.tsx');
    expect(main).toContain("window.addEventListener('dragover', refuseStrayFiles)");
    expect(main).toContain("window.addEventListener('drop', refuseStrayFiles)");
  });
});
