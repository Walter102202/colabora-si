import { Input, Select } from "@/components/FormControls";
import { lazy, Suspense, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { LayoutPanelLeft, Lock, Search, Table2, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { buildDbOps, buildLinkedDbOps } from "@/lib/dbOps";
import { filterRows, operatorsFor } from "@/lib/dbFilter";
import { sortRows } from "@/lib/dbCompute";
import { createView, newId } from "@/lib/factories";
import { rowSearchText, VIEW_ICONS, visibleProperties } from "@/lib/dbView";
import DatabaseRows from "@/components/database/DatabaseRows";
import ConditionInputs from "@/components/database/ConditionInputs";
import { downloadCsv } from "@/lib/export";
import type { ColorRule, DbViewType, FilterCondition } from "@/lib/types";
import { taskForPage, useAgentTasks } from "@/lib/agentTasks";
import { useAgentsStore } from "@/lib/agentsStore";
import { databaseTaskValues, subtaskProgress, waitingOnYouCount, waitingOnYouRows } from "@/lib/databaseTaskValues";
import { JobAccessNote } from "@/components/agents/AgentPropertyCell";
import { JobsBoard } from "@/components/agents/panel/JobsBoard";
import { useDatabaseRowTasks } from "@/lib/useDatabaseRowTasks";
import { jobState, jobWait } from "@/lib/agentJobs";
import { connectedRows } from "@/lib/agentConnect";
import { databaseDeps } from "@/lib/pageBodies";
import { usePageBodies } from "@/lib/usePageBodies";
import { pageUrl, withQuery } from "@/lib/routes";
const TaskProgress = lazy(() => import("@/components/agents/TaskProgress").then((module) => ({ default: module.TaskProgress })));
const VIEW_NAMES: Record<DbViewType, string> = { table: "Table", board: "Board", list: "List", gallery: "Gallery", calendar: "Calendar", timeline: "Timeline" };
const COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
export default function DatabaseView({ pageId, locked = false, linkedPageId, linkedBlockId }: { pageId: string; locked?: boolean; linkedPageId?: string; linkedBlockId?: string }) {
  const { pathname, search: routeSearch, hash } = useLocation(), navigate = useNavigate();
  const pages = useStore((s) => s.pages), page = pages[pageId];
  const bodies = usePageBodies(databaseDeps(pageId, pages));
  const [active, setActive] = useState(0), [search, setSearch] = useState(""), [searching, setSearching] = useState(false), [panel, setPanel] = useState("");
  const [openedProgressPage, setOpenedProgressPage] = useState<string | null>(null);
  const ops = useMemo(() => {
    const base = linkedPageId && linkedBlockId ? buildLinkedDbOps(pageId, linkedPageId, linkedBlockId) : buildDbOps(pageId);
    return locked ? { ...base, get database() { return base.database; }, locked: true, readOnly: true } : base;
  }, [pageId, locked, linkedPageId, linkedBlockId]);
  const database = page?.database ? ops.database : undefined;
  const tasks = useAgentTasks((s) => s.tasks), briefs = useAgentTasks((s) => s.briefs), agents = useAgentsStore((s) => s.agents);
  const agentTable = database?.properties.some((property) => property.type === "agentStatus");
  const { resolved, error: taskError, retry } = useDatabaseRowTasks(agentTable && bodies === "ready" ? database?.rows : undefined);
  const queryDatabase = useMemo(() => {
    if (bodies !== "ready" || !database) return undefined;
    const source = resolved ? { ...database, rows: database.rows.filter((row) => resolved.has(row.pageId)) } : database;
    return databaseTaskValues(source, tasks, agents, briefs);
  }, [bodies, database, resolved, tasks, agents, briefs]);
  const view = database?.views[active] ?? database?.views[0];
  const rows = useMemo(() => {
    if (!queryDatabase || !view) return [];
    const waiting = agentTable && view.name === "Waiting on you", working = agentTable && view.name === "Working";
    let source = queryDatabase.rows;
    if (waiting || working) {
      const statusId = database?.properties.find((property) => property.type === "agentStatus")?.id ?? "";
      const waitingId = database?.properties.find((property) => property.name === "Waiting on")?.id ?? "";
      const selected = waiting ? waitingOnYouRows(source, statusId, waitingId) : source.filter((row) => row.parentRowId ? row.cells[statusId] === "working" : row.cells[statusId] === "writing");
      const ids = new Set(selected.flatMap((row) => row.parentRowId ? [row.id, row.parentRowId] : [row.id]));
      source = source.filter((row) => ids.has(row.id));
    }
    return sortRows(filterRows(source, waiting || working ? { ...view, filters: [] } : view, queryDatabase, pages).filter((row) => !search.trim() || rowSearchText(row, queryDatabase, pages).includes(search.trim().toLowerCase())), view, queryDatabase, pages);
  }, [queryDatabase, view, pages, search, agentTable, database]);
  if (bodies === "loading" || (resolved?.size === 0 && !taskError)) return <div className="database-view" aria-busy="true"><div className="database-skeleton" /></div>;
  if (bodies === "unavailable") return <div className="empty-block">This database isn&apos;t on this device yet. Connect to the internet to open it.</div>;
  if (!database || !view) return null;
  // Presentation only: keep every saved view, filter, row and page preference intact.
  // Embedded and read-only databases retain their existing workspace controls.
  const canMountProgress = agentTable && !ops.readOnly && !linkedPageId && pathname === pageUrl(pageId);
  const canShowProgress = canMountProgress && view.type === "table";
  const showProgress = canShowProgress && new URLSearchParams(routeSearch).get("taskLayout") !== "table";
  if (showProgress && openedProgressPage !== pageId) setOpenedProgressPage(pageId);
  const keepProgress = canMountProgress && (showProgress || openedProgressPage === pageId);
  const location = pathname + routeSearch + hash;
  const setTaskLayout = (layout: "progress" | "table") => { void navigate(withQuery(location, { taskLayout: layout })); };
  const selectNewRow = (rowId: string) => {
    if (!showProgress || !rowId) return;
    const record = ops.database.rows.find((item) => item.id === rowId);
    if (record) void navigate(withQuery(location, { progressRow: record.pageId }));
  };
  const condition = (): FilterCondition => ({ id: newId(), propertyId: database.properties[0].id, operator: operatorsFor(database.properties[0].type)[0], value: "" });
  const patchFilter = (id: string, patch: Partial<FilterCondition>) => ops.updateView(view.id, { filters: (view.filters ?? []).map((f) => f.id === id ? { ...f, ...patch } : f) });
  const patchColor = (id: string, patch: Partial<ColorRule>) => ops.updateView(view.id, { colorRules: (view.colorRules ?? []).map((r) => r.id === id ? { ...r, ...patch } : r) });
  const waitingId = database.properties.find((property) => property.name === "Waiting on")?.id ?? "", statusId = database.properties.find((property) => property.type === "agentStatus")?.id ?? "";
  const waitingCount = queryDatabase ? waitingOnYouCount(queryDatabase.rows, statusId, waitingId) : 0;
  const progress = subtaskProgress(database, queryDatabase ?? database);
  const knownAgents = connectedRows(agents, []).map((agent) => ({ ...agent, id: agent.agentId }));
  const boardJobs = rows.filter((row) => !row.parentRowId).map((row) => {
    const task = taskForPage({ tasks }, row.pageId);
    const children = (queryDatabase?.rows ?? []).filter((child) => child.parentRowId === row.id).map((child) => taskForPage({ tasks }, child.pageId));
    return { id: row.id, title: String(row.cells.title || pages[row.pageId]?.title || "Untitled"), lead: knownAgents.find((agent) => agent.id === task?.delegate_agent_id) ?? null, state: jobState(task, children), progress: progress[row.id], waiting: jobWait(task, children) };
  });
  return <div className="database-view" data-task-layout={canShowProgress ? showProgress ? "progress" : "table" : undefined}>{database.properties.some((property) => property.type === "agentStatus") && <JobAccessNote dbPageId={pageId} />}<div className="database-tabs">{database.views.map((v, i) => <button key={v.id} aria-pressed={v.id === view.id} onClick={() => { setActive(i); setSearch(""); setPanel(""); }} onDoubleClick={() => { if (!ops.locked && !ops.readOnly) { setActive(i); setPanel("view"); } }}>{VIEW_ICONS[v.type]} {v.name}{agentTable && v.name === "Waiting on you" && waitingCount > 0 ? ` ${waitingCount}` : ""}</button>)}{!ops.locked && !ops.readOnly ? <button aria-label="New view" onClick={() => setPanel(panel === "add" ? "" : "add")}>+</button> : <Lock size={14} className="m-2 text-text-tertiary" aria-label="Database locked — structure edits are disabled" />}</div>
    {taskError && <div role="alert">{taskError} <button onClick={retry}>Retry loading tasks</button></div>}
    {canShowProgress && <div className="task-layout-switch" role="group" aria-label="Task view">
      <button type="button" aria-label="Show task progress" aria-pressed={showProgress} onClick={() => setTaskLayout("progress")}><LayoutPanelLeft size={15} aria-hidden="true" />Progress</button>
      <button type="button" aria-label="Show task table" aria-pressed={!showProgress} onClick={() => setTaskLayout("table")}><Table2 size={15} aria-hidden="true" />Table</button>
    </div>}
    {panel === "add" && <div className="database-panel">{(Object.keys(VIEW_NAMES) as DbViewType[]).map((type) => <button key={type} onClick={() => { ops.addView(createView({ name: VIEW_NAMES[type], type, ...(type === "board" ? { groupBy: database.properties.find((p) => ["select", "status", "agentStatus"].includes(p.type))?.id } : {}), ...(["calendar", "timeline"].includes(type) ? { dateProp: database.properties.find((p) => p.type === "date")?.id } : {}) })); setActive(database.views.length); setPanel(""); }}>{VIEW_ICONS[type]} {VIEW_NAMES[type]}</button>)}</div>}
    {panel === "view" && <div className="database-panel"><div>View name<Input label="View name" aria-label="View name" defaultValue={view.name} onBlur={(e) => ops.updateView(view.id, { name: e.target.value || "View" })} /></div><div>Layout<Select label="Layout" value={view.type} onChange={(e) => ops.updateView(view.id, { type: e.target.value as DbViewType })}>{Object.entries(VIEW_NAMES).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</Select></div><button className="danger" disabled={database.views.length < 2} onClick={() => { ops.deleteView(view.id); setActive(0); setPanel(""); }}>Delete view</button></div>}
    <div className="database-toolbar">{["Filter", "Sort", "Properties"].map((name) => <button key={name} disabled={ops.locked || ops.readOnly} title={ops.locked ? "Database is locked" : undefined} onClick={() => {
      if (name === "Filter" && !view.filters?.length) ops.updateView(view.id, { filters: [condition()] });
      if (name === "Sort" && !view.sorts?.length) ops.updateView(view.id, { sorts: [{ propertyId: database.properties[0].id, direction: "asc" }] });
      setPanel(panel === name ? "" : name);
    }}>{name}{name === "Filter" && !!view.filters?.length ? ` · ${view.filters.length}` : name === "Sort" && !!view.sorts?.length ? ` · ${view.sorts.length}` : ""}</button>)}<span className="ml-auto text-xs text-text-tertiary">{rows.length} {rows.length === 1 ? "item" : "items"}</span>{searching ? <div className="flex items-center"><Input label="Search this view" focusOnMount aria-label="Search this view" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => { if (!search) setSearching(false); }} onKeyDown={(e) => { if (e.key === "Escape") { setSearch(""); setSearching(false); } }} /><button className="icon-button" aria-label="Clear search" onClick={() => { setSearch(""); setSearching(false); }}><X size={14} /></button></div> : <button className="icon-button" aria-label="Search this view" onClick={() => setSearching(true)}><Search size={15} /></button>}<button aria-label="View options" onClick={() => setPanel(panel === "more" ? "" : "more")}>⋯</button>{!ops.readOnly && <><button className="new-button" onClick={() => selectNewRow(ops.addRow())}>{agentTable ? "New job" : "New"}</button><button aria-label="New from template" onClick={() => setPanel(panel === "templates" ? "" : "templates")}>▾</button></>}</div>
    {panel === "more" && <div className="database-panel"><button disabled={ops.locked || ops.readOnly} onClick={() => setPanel("colors")}>Color rules{view.colorRules?.length ? ` · ${view.colorRules.length}` : ""}</button>{["table", "board"].includes(view.type) && <div>Group by<Select label="Group by" aria-label="Group by" disabled={ops.locked || ops.readOnly} value={view.groupBy ?? ""} onChange={(e) => ops.updateView(view.id, { groupBy: e.target.value || undefined })}><option value="">None</option>{database.properties.filter((p) => view.type !== "board" || ["select", "status", "agentStatus"].includes(p.type)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}{view.type === "calendar" && <div>Date property<Select label="Calendar date property" aria-label="Calendar date property" disabled={ops.locked || ops.readOnly} value={view.dateProp ?? database.properties.find((p) => p.type === "date")?.id ?? ""} onChange={(e) => ops.updateView(view.id, { dateProp: e.target.value })}>{database.properties.filter((p) => p.type === "date").map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}<button onClick={() => { downloadCsv(page.title, visibleProperties(queryDatabase ?? database, view), rows, queryDatabase ?? database, pages); setPanel(""); }}>Export CSV</button><button disabled={ops.readOnly} onClick={() => { ops.setLocked(!ops.locked); setPanel(""); }}>{ops.locked ? "Unlock database" : "Lock database"}</button></div>}
    {panel === "Properties" && <div className="database-panel"><strong>Properties in this view</strong>{database.properties.map((p) => <div key={p.id} className="flex gap-2"><Input label="Show property" type="checkbox" checked={p.id === "title" || !view.hiddenProps?.includes(p.id)} disabled={p.id === "title"} onChange={(e) => ops.updateView(view.id, { hiddenProps: e.target.checked ? (view.hiddenProps ?? []).filter((id) => id !== p.id) : [...(view.hiddenProps ?? []), p.id] })} />{p.name}</div>)}</div>}
    {panel === "Filter" && <div className="database-panel"><Select label="Combine filters" aria-label="Combine filters" value={view.filterConjunction ?? "and"} onChange={(e) => ops.updateView(view.id, { filterConjunction: e.target.value as "and" | "or" })}><option value="and">All (And)</option><option value="or">Any (Or)</option></Select>{(view.filters ?? []).map((filter) => <div className="flex flex-wrap gap-2" key={filter.id}><ConditionInputs condition={filter} database={database} onChange={(patch) => patchFilter(filter.id, patch)} /><button aria-label="Delete filter" onClick={() => ops.updateView(view.id, { filters: view.filters?.filter((f) => f.id !== filter.id) })}>×</button></div>)}{!view.filters?.length && <p>No filters applied to this view.</p>}<button onClick={() => ops.updateView(view.id, { filters: [...(view.filters ?? []), condition()] })}>+ Add filter</button><button onClick={() => ops.updateView(view.id, { filters: [] })}>Delete all</button></div>}
    {panel === "Sort" && <div className="database-panel">{(view.sorts ?? []).map((sort, i) => <div className="flex gap-2" key={i}><Select label="Sort property" aria-label="Sort property" value={sort.propertyId} onChange={(e) => ops.updateView(view.id, { sorts: view.sorts?.map((s, n) => i === n ? { ...s, propertyId: e.target.value } : s) })}>{database.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select><Select label="Sort direction" aria-label="Sort direction" value={sort.direction} onChange={(e) => ops.updateView(view.id, { sorts: view.sorts?.map((s, n) => i === n ? { ...s, direction: e.target.value as "asc" | "desc" } : s) })}><option value="asc">Ascending</option><option value="desc">Descending</option></Select><button aria-label="Remove sort" onClick={() => ops.updateView(view.id, { sorts: view.sorts?.filter((_, n) => n !== i) })}>×</button></div>)}{!view.sorts?.length && <p>No sorts applied to this view.</p>}<button onClick={() => ops.updateView(view.id, { sorts: [...(view.sorts ?? []), { propertyId: database.properties.find((p) => !view.sorts?.some((s) => s.propertyId === p.id))?.id ?? database.properties[0].id, direction: "asc" }] })}>+ Add sort</button><button onClick={() => ops.updateView(view.id, { sorts: [] })}>Delete all</button></div>}
    {panel === "colors" && <div className="database-panel"><strong>Color rows when… (first matching rule wins)</strong>{view.colorRules?.map((rule) => <div key={rule.id} className="flex flex-wrap gap-2"><ConditionInputs condition={rule} database={database} onChange={(patch) => patchColor(rule.id, patch)} /><Select label="Row color" aria-label="Row color" value={rule.color} onChange={(e) => patchColor(rule.id, { color: e.target.value })}>{COLORS.map((color) => <option key={color} value={color}>{color[0].toUpperCase() + color.slice(1)}</option>)}</Select><button aria-label="Delete color rule" onClick={() => ops.updateView(view.id, { colorRules: view.colorRules?.filter((r) => r.id !== rule.id) })}>×</button></div>)}{!view.colorRules?.length && <p>No color rules on this view.</p>}<button onClick={() => ops.updateView(view.id, { colorRules: [...(view.colorRules ?? []), { ...condition(), color: COLORS[(view.colorRules?.length ?? 0) % COLORS.length] }] })}>+ Add color rule</button><button onClick={() => ops.updateView(view.id, { colorRules: [] })}>Delete all</button></div>}
    {panel === "templates" && <div className="database-panel"><strong>Templates</strong>{!database.rowTemplates?.length && <p>No templates yet. Use the save button on a row to save it as a template.</p>}{database.rowTemplates?.map((template) => <div className="flex justify-between" key={template.id}><button onClick={() => { selectNewRow(ops.addRowFromTemplate(template.id)); setPanel(""); }}>{template.icon ?? "📄"} {template.name}</button><button aria-label="Delete template" onClick={() => ops.deleteRowTemplate(template.id)}>×</button></div>)}</div>}
    {keepProgress && <div hidden={!showProgress} inert={!showProgress || undefined}><Suspense fallback={<div className="min-h-40 p-4 text-sm text-text-secondary" aria-busy="true" aria-label="Loading task progress">Loading task progress…</div>}><TaskProgress key={pageId} pageId={pageId} rows={rows} allRows={queryDatabase?.rows ?? database.rows} onOpenRow={ops.openRow} active={showProgress} /></Suspense></div>}
    {!showProgress && (agentTable && view.type === "board" ? <JobsBoard jobs={boardJobs} onOpen={(id) => ops.openRow(id)} /> : <DatabaseRows ops={ops} database={database} queryDatabase={queryDatabase} view={view} rows={rows} pages={pages} />)}
  </div>;
}
