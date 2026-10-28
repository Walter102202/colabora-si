export function openPeek(pageId: string) {
  window.dispatchEvent(new CustomEvent("colabora-peek", { detail: pageId }));
}
