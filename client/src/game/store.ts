import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get: () => T;
  set: (patch: Partial<T>) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Selectors must return stored references or primitives (no fresh objects). */
export function useStore<T extends object, U>(store: Store<T>, sel: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
