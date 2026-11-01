import { createContext, useContext } from "react";
import type { BlockDestination } from "@/lib/blockOps";
import type { Block } from "@/lib/types";

export type Surface = { snapshot: () => Block[]; clearSelection: () => void };
export type DragState = { ids: string[]; target: BlockDestination | null };
export const BlockDragContext = createContext<{
  state: DragState;
  columns: { id: string; label: string }[];
  register: (columnId: string | null, surface: Surface) => () => void;
  start: (ids: string[]) => void;
  target: (target: BlockDestination) => void;
  finish: (cancel?: boolean) => void;
  move: (ids: string[], target: BlockDestination) => void;
} | null>(null);

export const useBlockDrag = () => useContext(BlockDragContext);

