import { describe, expect, it } from 'vitest';
import { HookHost, hooks } from './web-hook-host';

describe('test hook host', () => {
  it('fails a component that sets new state after every render', () => {
    const host = new HookHost(() => {
      const [, setItems] = hooks.useState<number[]>([]);
      const items = [1];
      hooks.useEffect(() => setItems(items), [items]);
      return null;
    });
    expect(() => host.render()).toThrow(/re-render/);
  });
});
