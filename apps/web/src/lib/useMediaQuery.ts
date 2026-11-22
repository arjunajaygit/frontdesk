import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. Used where a component must render in exactly ONE place per layout
 * (duplicating DOM and hiding a copy with CSS would duplicate accessible names). False when matchMedia is
 * unavailable (tests, old browsers), which selects the compact layout.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && !!window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}
