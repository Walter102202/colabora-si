import { useState } from "react";
import { Input, Select } from "@/components/FormControls";
import { isAutoProperty } from "@/lib/dbView";
import type { Database } from "@/lib/types";
import type { DbOps } from "@/lib/dbOps";

export default function RowSelectionToolbar({ ids, database, ops, clear }: { ids: string[]; database: Database; ops: DbOps; clear: () => void }) {
  const [propertyId, setPropertyId] = useState(""), [value, setValue] = useState("");
  const properties = database.properties.filter((p) => !isAutoProperty(p, database) && p.id !== "title" && ["text", "number", "select", "status", "checkbox", "date", "url", "email", "phone"].includes(p.type));
  const property = properties.find((p) => p.id === propertyId);
  const options = property?.type === "select" || property?.type === "status";
  const apply = () => {
    if (!property || ops.readOnly) return;
    const parsed = property.type === "checkbox" ? value === "true" : value === "" ? null : property.type === "number" ? Number(value) : value;
    if (typeof parsed === "number" && !Number.isFinite(parsed)) return;
    ops.updateCells(ids, property.id, parsed);
  };
  return <div className="row-selection-toolbar" role="toolbar" aria-label="Selected rows">
    <strong>{ids.length} selected</strong>
    {!ops.readOnly && <>
      <Select label="Property to update" value={propertyId} onChange={(event) => { setPropertyId(event.target.value); setValue(""); }}>
        <option value="">Change property…</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
      {property && <>{options ? <Select label={`New ${property.name}`} value={value} onChange={(event) => setValue(event.target.value)}><option value="">Clear value</option>{property.options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
        : property.type === "checkbox" ? <Select label={`New ${property.name}`} value={value} onChange={(event) => setValue(event.target.value)}><option value="">Unchecked</option><option value="true">Checked</option></Select>
          : <Input label={`New ${property.name}`} type={property.type === "number" ? "number" : property.type === "date" ? "date" : "text"} value={value} onChange={(event) => setValue(event.target.value)} />}
        <button className="action-button" onClick={apply}>Apply to selected</button></>}
      <button className="danger" onClick={() => { ops.deleteRows(ids); clear(); }}>Move to trash</button>
    </>}
    <button aria-label="Clear row selection" onClick={clear}>×</button>
  </div>;
}
