import type * as Zustand from '../../apps/web/node_modules/zustand/esm/index.mjs';

/**
 * zustand whose stores read their current state when rendered to a string; server rendering
 * otherwise reads each store's initial state. Use as `vi.mock(<zustand path>, liveStores)`.
 */
export async function liveStores(actual: () => Promise<typeof Zustand>) {
  const zustand = await actual();
  const bind = (init: Zustand.StateCreator<unknown>) => {
    const api = zustand.createStore(init);
    return Object.assign(
      (select: (state: unknown) => unknown = (state) => state) => select(api.getState()),
      api,
    );
  };
  const create = (init?: Zustand.StateCreator<unknown>) => (init ? bind(init) : bind);
  return { ...zustand, create };
}
