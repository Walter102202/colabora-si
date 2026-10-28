"use client";
import { createContext, useContext } from "react";
import { useStore } from "@/lib/store";
import type { Block, Page } from "@/lib/types";
export interface ReadOnlyData { pages: Record<string, Page>; syncedBlocks: Record<string, Block[]>; linkBase: string | null; openPage?: (pageId: string) => void; }
const Context = createContext<ReadOnlyData | null>(null);
export const ReadOnlyDataProvider = Context.Provider;
export const useReadOnlyData = () => useContext(Context);
export function useResolvedPages(): Record<string, Page> { const context = useReadOnlyData(), pages = useStore((s) => s.pages); return context?.pages ?? pages; }
export function useResolvedPage(id?: string): Page | undefined { return useResolvedPages()[id ?? ""]; }
export function useResolvedSyncedBlocks(key: string): Block[] | undefined { const context = useReadOnlyData(), blocks = useStore((s) => s.syncedBlocks?.[key]); return context ? context.syncedBlocks[key] : blocks; }
