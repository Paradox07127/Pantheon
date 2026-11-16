import { expect, it, vi } from 'vitest';

// The window and its storage exist before the module loads, as in the app, so its storage
// listener is in place.
const mock = vi.hoisted(() => {
  const state = {
    items: new Map<string, string>(),
    listeners: new Set<(event: any) => void>(),
  };
  Object.assign(globalThis, {
    window: {
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (type === 'storage') state.listeners.add(listener);
      },
      removeEventListener: () => {},
    },
    localStorage: {
      get length() {
        return state.items.size;
      },
      key: (i: number) => [...state.items.keys()][i] ?? null,
      getItem: (key: string) => state.items.get(key) ?? null,
      setItem: (key: string, value: string) => void state.items.set(key, value),
      removeItem: (key: string) => void state.items.delete(key),
    },
  });
  return state;
});
import { draftKey, useDrafts, whenUploaded } from '@/data/drafts';

it('keeps counting its own uploads when another window sends the draft', async () => {
  const key = draftKey('project-a', 'session-a');
  useDrafts.getState().update(key, (d) => ({ text: 'hello', uploading: d.uploading + 1 }));
  mock.items.delete(`pantheon.draft.${key}`);
  for (const listener of mock.listeners) listener({ key: `pantheon.draft.${key}`, newValue: null });
  expect(useDrafts.getState().drafts[key]?.uploading).toBe(1);
  useDrafts.getState().update(key, (d) => ({ uploading: d.uploading - 1 }));
  let done = false;
  await whenUploaded(key).then(() => (done = true));
  expect(done).toBe(true);
  expect(useDrafts.getState().drafts[key]?.uploading).toBe(0);
});
