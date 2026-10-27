"use client";
import { useState } from "react";
import Cell from "@/components/database/cells/Cell";
import type { DbOps } from "@/lib/dbOps";
import type { DbRow, Page } from "@/lib/types";
import { TYPE_ICONS } from "@/components/database/dbShared";
export default function RowProperties({ ops, row, pages }: { ops: DbOps; row: DbRow; pages: Record<string, Page> }) {
  const [expanded, setExpanded] = useState(false), database = ops.database, props = database.properties.filter((p) => p.id !== "title");
  return <div className="row-properties">{(expanded ? props : props.slice(0, 6)).map((property) => <div className="row-property" key={property.id}><span className="truncate text-text-secondary">{TYPE_ICONS[property.type]} {property.name}</span><Cell ops={ops} database={database} row={row} property={property} pages={pages} /></div>)}{props.length > 6 && <button className="mt-2 text-xs text-text-tertiary" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer properties" : `Show ${props.length - 6} more ${props.length === 7 ? "property" : "properties"}`}</button>}</div>;
}
