"use client";
import { useState } from "react";
import { createPortal } from "react-dom";
import { aggregate, aggregationsFor, AGG_LABELS } from "@/lib/dbCompute";
import type { DbProperty } from "@/lib/types";
import type { ViewProps } from "@/components/database/dbShared";
export default function AggregationCell({ property, ops, database, view, rows, pages }: ViewProps & { property: DbProperty }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null), fn = view.aggregations?.[property.id] ?? "none", options = aggregationsFor(property.type);
  const label = fn === "none" ? "Calculate" : `${AGG_LABELS[fn]} ${aggregate(fn, rows, property, database, pages)}`;
  return <><button className={`aggregation-cell ${fn === "none" ? "empty" : ""}`} disabled={ops.readOnly} onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>{label}</button>{anchor && createPortal(<><button className="cell-backdrop" aria-label="Close calculation" onClick={() => setAnchor(null)} /><div className="menu-panel cell-popover max-h-56 overflow-y-auto" style={{ width: 176, left: Math.max(8, Math.min(anchor.right - 176, innerWidth - 184)), top: Math.max(8, anchor.top - Math.min(224, options.length * 32 + 8) - 4) }}>{options.map((value) => <button key={value} onClick={() => { ops.updateView(view.id, { aggregations: { ...view.aggregations, [property.id]: value } }); setAnchor(null); }}>{AGG_LABELS[value]}{value === fn ? " ✓" : ""}</button>)}</div></>, document.body)}</>;
}
