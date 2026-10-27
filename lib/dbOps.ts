import type { Database, DbRow, DbProperty, DbView, ButtonAction } from "@/lib/types";
import { useStore } from "@/lib/store";
import { openPeek } from "@/lib/peek";
import { withViewTransition } from "@/lib/viewTransition";
import { runAgentAction } from "@/lib/agentActions";
import { newId } from "@/lib/factories";
import { cloneWithNewIds } from "@/lib/pageMutations";
export interface DbOps {
  pageId: string; database: Database; locked: boolean; readOnly: boolean;
  addRow: (patch?: Partial<DbRow>) => string;
  updateCell: (rowId: string, propertyId: string, value: unknown) => void;
  deleteRow: (rowId: string) => void;
  addProperty: (prop?: Partial<DbProperty>) => void;
  updateProperty: (propId: string, patch: Partial<DbProperty>) => void;
  deleteProperty: (propId: string) => void;
  addView: (view: DbView) => void;
  updateView: (viewId: string, patch: Partial<DbView>) => void;
  deleteView: (viewId: string) => void;
  setLocked: (locked: boolean) => void;
  addRowFromTemplate: (templateId: string) => string;
  saveRowAsTemplate: (rowId: string, name: string) => void;
  deleteRowTemplate: (templateId: string) => void;
  openRow: (rowId: string) => void;
  runButton: (rowId: string, action: ButtonAction) => void; // kind "agentTask" → runAgentAction(action, { pageId: rowPageId })
}

const cached = new Map<string, DbOps>();
export function buildDbOps(pageId: string): DbOps {
  const existing = cached.get(pageId);
  if (existing) return existing;
  const state = () => useStore.getState();
  const editable = () => !!state().pages[pageId]?.database && !state().pages[pageId]?.locked;
  const ops: DbOps = {
    pageId,
    get database() { return state().pages[pageId].database!; },
    get locked() { return !!state().pages[pageId]?.database?.locked; },
    get readOnly() { return !!state().pages[pageId]?.locked; },
    addRow: (patch) => editable() ? state().addRow(pageId, patch) : "",
    updateCell: (rowId, propertyId, value) => { if (editable()) state().updateCell(pageId, rowId, propertyId, value); },
    deleteRow: (rowId) => { if (editable()) state().deleteRow(pageId, rowId); },
    addProperty: (prop) => { if (editable()) state().addProperty(pageId, prop); },
    updateProperty: (id, patch) => { if (editable()) state().updateProperty(pageId, id, patch); },
    deleteProperty: (id) => { if (editable()) state().deleteProperty(pageId, id); },
    addView: (view) => { if (editable()) state().addView(pageId, view); },
    updateView: (id, patch) => { if (editable()) state().updateView(pageId, id, patch); },
    deleteView: (id) => { if (editable()) state().deleteView(pageId, id); },
    setLocked: (locked) => { if (editable()) state().setDbLocked(pageId, locked); },
    addRowFromTemplate: (id) => editable() ? state().addRowFromTemplate(pageId, id) : "",
    saveRowAsTemplate: (id, name) => { if (editable()) state().saveRowAsTemplate(pageId, id, name); },
    deleteRowTemplate: (id) => { if (editable()) state().deleteRowTemplate(pageId, id); },
    openRow: (id) => { const row = ops.database.rows.find((r) => r.id === id); withViewTransition(() => openPeek(row?.pageId ?? id)); },
    runButton: (rowId, action) => {
      if (!editable()) return;
      const row = ops.database.rows.find((r) => r.id === rowId), rowPage = row ? state().pages[row.pageId] : undefined;
      if (!rowPage) return;
      if (action.kind === "agentTask") { void runAgentAction(action, { pageId: rowPage.id }); return; }
      if (action.kind === "openPage" && action.pageId) withViewTransition(() => openPeek(action.pageId!));
      if (action.kind === "insertBlocks") state().setBlocks(rowPage.id, [...rowPage.blocks, ...cloneWithNewIds(action.blocks)]);
    },
  };
  cached.set(pageId, ops);
  return ops;
}

export function createLinkedViews(database: Database): DbView[] {
  return database.views.map((view) => ({ ...structuredClone(view), id: newId() }));
}

export function buildLinkedDbOps(sourceId: string, hostPageId: string, blockId: string): DbOps {
  const source = buildDbOps(sourceId);
  const host = () => useStore.getState().pages[hostPageId];
  const block = () => host()?.blocks.find((b) => b.id === blockId);
  const views = () => block()?.linkedViews ?? source.database.views;
  const changeViews = (change: (views: DbView[]) => DbView[]) => {
    if (!host() || host().locked || source.readOnly || source.locked || !block()) return;
    const current = views(), next = change(current);
    if (next !== current) useStore.getState().updateBlock(hostPageId, blockId, { linkedViews: next });
  };
  return {
    ...source,
    get database() { return { ...source.database, views: views() }; },
    get locked() { return !!host()?.locked || source.locked; },
    get readOnly() { return !!host()?.locked || source.readOnly; },
    addView: (view) => changeViews((views) => [...views, view]),
    updateView: (id, patch) => changeViews((views) => views.some((v) => v.id === id) ? views.map((view) => view.id === id ? { ...view, ...patch, id } : view) : views),
    deleteView: (id) => changeViews((views) => views.length > 1 && views.some((v) => v.id === id) ? views.filter((view) => view.id !== id) : views),
  };
}
