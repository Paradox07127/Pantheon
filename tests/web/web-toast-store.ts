import type { ReactElement } from 'react';
import { ToastStore } from '../../apps/web/node_modules/@base-ui/react/toast/store.mjs';
import { ToastItems, Toasts, toastManager } from '../../apps/web/src/components/Toast.js';
import { nodes } from './web-hook-host.js';

// The parts of Base UI's store the viewport drives; its base class's types do not resolve from here.
export interface ToastStoreView {
  state: {
    toasts: {
      title?: unknown;
      limited?: boolean;
      transitionStatus?: string;
      actionProps?: { children?: unknown; onClick?: (event: never) => void };
    }[];
  };
  set(key: 'hovering' | 'focused', value: boolean): void;
  pauseTimers(): void;
  resumeTimers(): void;
  addToast(options: object): string;
  closeToast(id?: string): void;
}

/** A Base UI toast store fed by the app's manager with the provider's settings, as the provider feeds it. */
export function mountToastStore() {
  const provider = Toasts() as ReactElement<{
    limit: number;
    timeout: number;
    toastManager: typeof toastManager;
  }>;
  const { limit, timeout, toastManager: manager } = provider.props;
  const store: ToastStoreView = new ToastStore({
    timeout,
    limit,
    viewport: null,
    toasts: [],
    hovering: false,
    focused: false,
    isWindowFocused: true,
    prevFocusElement: null,
  }) as unknown as ToastStoreView;
  const stop = manager[' subscribe'](({ action, options }) =>
    action === 'close' ? store.closeToast(options.id) : store.addToast(options),
  );
  const shown = () =>
    store.state.toasts
      .filter((one) => one.transitionStatus !== 'ending' && !one.limited)
      .map((one) => one.title);
  const tree = () => ToastItems({ toasts: store.state.toasts as never });
  return { store, stop, shown, tree, items: () => nodes(tree()) };
}
