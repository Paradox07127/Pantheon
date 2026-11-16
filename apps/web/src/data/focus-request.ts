import { useSyncExternalStore } from 'react';

let wanted: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The approval whose request card is to scroll into view and take focus once it shows. */
export const wantedRequest = () => wanted;

/** Asks for the request card of the approval; null drops the ask. */
export function focusRequest(id: string | null): void {
  wanted = id;
  listeners.forEach((listener) => listener());
}

export function useWantedRequest(): string | null {
  return useSyncExternalStore(subscribe, wantedRequest, wantedRequest);
}
