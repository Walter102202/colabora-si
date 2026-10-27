"use client";
import { Fragment, useRef, useState } from "react";
import type { Block, ColumnData } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { createBlock, newId } from "@/lib/factories";
import NestedEditor from "@/components/blocks/NestedEditor";
export default function ColumnsBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const [fallback] = useState<ColumnData[]>(() => [0, 1].map(() => ({ id: newId(), blocks: [createBlock()] })));
  const columns = block.columns?.length ? block.columns : fallback;
  const container = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; widths: number[]; ratio: number; index: number } | null>(null);
  const [widths, setWidths] = useState<number[] | null>(null), live = useRef<number[] | null>(null);
  const end = () => { if (live.current) ops.updateBlock(block.id, { columns: columns.map((c, i) => ({ ...c, width: Math.round(live.current![i] * 1000) / 1000 })) }); drag.current = null; live.current = null; setWidths(null); };
  return <div ref={container} className="columns-block" contentEditable={false}>{columns.map((column, i) => <Fragment key={column.id}>
    {i > 0 && <div className="editor-column-resizer" role="separator" aria-orientation="vertical" aria-label="Drag to resize columns" onPointerDown={(event) => {
      if (ops.locked) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
      const start = columns.map((c) => c.width ?? 1); drag.current = { x: event.clientX, widths: start, ratio: start.reduce((a, b) => a + b, 0) / (container.current?.clientWidth || 1), index: i - 1 };
    }} onPointerMove={(event) => {
      const start = drag.current; if (!start) return;
      const j = start.index, pair = start.widths[j] + start.widths[j + 1], min = Math.min(start.widths.reduce((a, b) => a + b, 0) * 0.1, pair / 2);
      const a = Math.max(min, Math.min(pair - min, start.widths[j] + (event.clientX - start.x) * start.ratio)), next = [...start.widths];
      next[j] = a; next[j + 1] = pair - a; live.current = next; setWidths(next);
    }} onPointerUp={end} onPointerCancel={end}><span /></div>}
    <div className="editor-column" style={{ flex: `${widths?.[i] ?? column.width ?? 1} 1 0%` }}>
      {!ops.locked && columns.length > 1 && <button className="column-delete hover-actions icon-button" aria-label="Delete column" onClick={() => ops.updateBlock(block.id, { columns: columns.filter((c) => c.id !== column.id) })}>×</button>}
      <NestedEditor blocks={column.blocks} pageId={ops.pageId} locked={ops.locked} onChange={(blocks) => ops.updateBlock(block.id, { columns: columns.map((c) => c.id === column.id ? { ...c, blocks } : c) })} />
    </div>
  </Fragment>)}{!ops.locked && columns.length < 5 && <button className="hover-actions icon-button" aria-label="Add column" onClick={() => ops.updateBlock(block.id, { columns: [...columns, { id: newId(), blocks: [createBlock()] }] })}>+</button>}</div>;
}

