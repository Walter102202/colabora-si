export function withViewTransition(fn: () => void): void {
  if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(fn);
  else fn();
}
