"use client";
import Editable from "@/components/Editable";
import type { Block } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { sanitizeHtml } from "@/lib/utils";
export default function TableBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const rows = block.table?.length ? block.table : [["", "", ""], ["", "", ""]], cols = rows[0].length;
  const update = (table: string[][]) => ops.updateBlock(block.id, { table });
  return <div className="simple-table-wrap" contentEditable={false}><table className="ntable"><tbody>
    {!ops.locked && <tr className="table-controls"><td />{rows[0].map((_, c) => <td key={c}><button disabled={cols < 2} aria-label="Delete column" onClick={() => update(rows.map((r) => r.filter((_, i) => i !== c)))}>×</button></td>)}<td /></tr>}
    {rows.map((row, r) => <tr key={r}>{!ops.locked && <td className="table-controls"><button aria-label="Delete row" disabled={rows.length < 2} onClick={() => update(rows.filter((_, i) => i !== r))}>×</button></td>}{row.map((cell, c) => <td key={c} className={(r === 0 && block.tableHeaderRow) || (c === 0 && block.tableHeaderCol) ? "ntable-th" : ""}><Editable html={cell} readOnly={ops.locked} placeholder=" " className="text-sm" onBlurSave={(html) => update(rows.map((line, i) => i === r ? line.map((value, j) => j === c ? sanitizeHtml(html) : value) : line))} /></td>)}{!ops.locked && r === 0 && <td className="table-controls" rowSpan={rows.length}><button aria-label="Add column" onClick={() => update(rows.map((line) => [...line, ""]))}>+</button></td>}</tr>)}
    {!ops.locked && <tr className="table-controls"><td /><td colSpan={cols}><button className="w-full" aria-label="Add row" onClick={() => update([...rows, Array(cols).fill("")])}>+</button></td></tr>}
  </tbody></table>{!ops.locked && <div className="table-controls flex gap-2 text-xs"><button aria-pressed={!!block.tableHeaderRow} onClick={() => ops.updateBlock(block.id, { tableHeaderRow: !block.tableHeaderRow })}>Header row</button><button aria-pressed={!!block.tableHeaderCol} onClick={() => ops.updateBlock(block.id, { tableHeaderCol: !block.tableHeaderCol })}>Header column</button></div>}</div>;
}
