import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(change: () => void) {
  const media = matchMedia(QUERY);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => matchMedia(QUERY).matches);
}
