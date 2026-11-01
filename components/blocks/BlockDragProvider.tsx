import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { movePageBlocks, type BlockDestination } from "@/lib/blockOps";
import type { Block, Page } from "@/lib/types";
import { createBlock } from "@/lib/factories";
import { historyAction } from "@/lib/history";
import { BlockDragContext, type DragState, type Surface } from "./BlockDragContext";

const idle: DragState = { ids: [], target: null };

export function BlockDragProvider({ blocks, onChange, locked, subpages = [], children }: { blocks: Block[]; onChange: (blocks: Block[]) => void; locked?: boolean; subpages?: Page[]; children: ReactNode }) {
  const latest = useRef({ blocks, onChange, locked, subpages }), surfaces = useRef(new Map<string | null, Surface>()), drag = useRef(idle);
  const pendingPage = useRef<Block | null>(null);
  const [state, setState] = useState(idle);
  useLayoutEffect(() => { latest.current = { blocks, onChange, locked, subpages }; });
  const api = useMemo(() => {
    const cancel = () => { pendingPage.current = null; drag.current = idle; setState(idle); };
    const move = (ids: string[], target: BlockDestination) => {
      if (latest.current.locked) return;
      // Read live editable values before unmounting a moved block or column.
      const snapshot = (blocks: Block[], columnId: string | null): Block[] => (surfaces.current.get(columnId)?.snapshot() ?? blocks).map((block) => block.columns ? { ...block, columns: block.columns.map((column) => ({ ...column, blocks: snapshot(column.blocks, column.id) })) } : block);
      const pending = pendingPage.current;
      // Opening and hovering never materialize a link. Recheck before dropping so
      // a concurrent link or reparent cannot create another reference here.
      if (pending && !latest.current.subpages.some((page) => page.id === pending.pageId)) return;
      const saved = snapshot(latest.current.blocks, null), current = pending ? [...saved, pending] : saved;
      const next = movePageBlocks(current, ids, target);
      if (next !== current) {
        latest.current.blocks = next;
        if (pending) historyAction(() => latest.current.onChange(next)); else latest.current.onChange(next);
        for (const surface of surfaces.current.values()) surface.clearSelection();
      }
    };
    return {
      register: (columnId: string | null, surface: Surface) => { surfaces.current.set(columnId, surface); return () => { surfaces.current.delete(columnId); }; },
      start: (ids: string[]) => { if (latest.current.locked) return; pendingPage.current = null; drag.current = { ids, target: null }; setState(drag.current); },
      startPage: (pageId: string) => {
        if (latest.current.locked || !latest.current.subpages.some((page) => page.id === pageId)) return;
        const block = createBlock("page", { pageId }); pendingPage.current = block;
        drag.current = { ids: [block.id], target: null }; setState(drag.current);
      },
      target: (target: BlockDestination) => { if (!drag.current.ids.length || (drag.current.target?.columnId === target.columnId && drag.current.target.id === target.id && drag.current.target.position === target.position)) return; drag.current = { ...drag.current, target }; setState(drag.current); },
      finish: (aborted = false) => { const { ids, target } = drag.current; if (!aborted && target) move(ids, target); cancel(); },
      move,
    };
  }, []);
  const columns: { id: string; label: string }[] = [];
  const collect = (list: Block[], prefix = "") => { for (const block of list) for (const [index, column] of (block.columns ?? []).entries()) { const label = `${prefix}Column ${index + 1}`; columns.push({ id: column.id, label }); collect(column.blocks, `${label} / `); } };
  collect(blocks);
  return <BlockDragContext.Provider value={{ ...api, state, columns }}>{children}</BlockDragContext.Provider>;
}
