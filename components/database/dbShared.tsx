import type { DbRow, DbProperty, Database, Page } from "@/lib/types";
import { computeCell, displayValue } from "@/lib/dbCompute";
import { AgentPropertyCell } from "@/components/agents/AgentPropertyCell";
export function CellPreview({ row, property, database, pages }: { row: DbRow; property: DbProperty; database: Database; pages: Record<string, Page> }) {
  if (property.type === "agentStatus" || property.type === "agentDelegate") return <AgentPropertyCell pageId={row.pageId} propertyId={property.id} kind={property.type} />;
  const value = computeCell(row, property, database, pages), text = displayValue(value, property, database, pages);
  if (["select", "status", "multiSelect"].includes(property.type)) return <OptionPills property={property} value={value} />;
  if (property.type === "checkbox") return <span className="text-sm" aria-label={value ? "Checked" : "Unchecked"}>{value ? "☑" : "☐"}</span>;
  return text ? <span className="text-xs text-text-secondary">{text}</span> : null;
}
export function OptionPills({ property, value }: { property: DbProperty; value: unknown }) {
  const ids = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return <span className="inline-flex flex-wrap gap-1">{ids.map((id) => property.options?.find((o) => o.id === id)).filter((o) => !!o).map((o) => property.type === "status" ? <span key={o.id} className="inline-flex items-center gap-1 text-xs"><span className={`inline-block h-2 w-2 rounded-full bc-${o.color}`} />{o.name}</span> : <span key={o.id} className={`rounded px-1.5 py-0.5 text-xs bc-${o.color} tc-${o.color}`}>{o.name}</span>)}</span>;
}
