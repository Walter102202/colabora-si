import { create } from "zustand";

interface PeekState {
  pageId: string | null;
  open: (pageId: string) => void;
  close: () => void;
}
export const usePeek = create<PeekState>((set) => ({
  pageId: null,
  open: (pageId) => set({ pageId }),
  close: () => set({ pageId: null }),
}));
export function openPeek(pageId: string) { usePeek.getState().open(pageId); }
