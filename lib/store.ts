import { mark, pageDataSizes, recordHydration } from "@/lib/metrics";
import { VERSION_CAP } from "@/lib/pageOps";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Block, BlockType, DbProperty, DbRow, DbView, Page, Reminder, TemplatePlan, WorkspaceSettings, WorkspaceState } from "@/lib/types";
import { createBlock, createDatabase, createPage as makePage, DEFAULT_SETTINGS, newId } from "@/lib/factories";
import * as pm from "@/lib/pageMutations";
import * as dm from "@/lib/dbMutations";
import { createPageFromTemplate as materializeTemplate, sanitizeBlocks, seedWorkspace } from "@/lib/seed";
import { foreignPageIds } from "@/lib/foreignPages";
import { stripHtml } from "@/lib/utils";
import { useAuthStore } from "@/lib/auth";

import { collectSubtreeFileIds, collectTrashFileIds, scheduleBlobGc } from "@/lib/fileStore";
export interface RemotePatch {
  pages?: Record<string, Page | null>;
  rootOrder?: string[];
  syncedBlocks?: Record<string, Block[]>;
  settings?: WorkspaceSettings;
  reminders?: Reminder[];
}
interface SyncState { syncWorkspaceId: string | null; syncUserId: string | null }
export type Store = WorkspaceState & SyncState & Actions;
interface Actions {
  persistInitialWorkspace: () => void;
  // sincronización (§II.7)
  setSyncWorkspaceId: (id: string | null, userId?: string | null) => void;
  applyRemotePages: (patch: RemotePatch) => void;

  // páginas
  createPage: (parentId?: string | null, patch?: Partial<Page>) => string;
  createDatabasePage: (parentId?: string | null) => string;
  createPageFromTemplate: (plan: TemplatePlan, parentId?: string | null) => string;
  applyTemplate: (pageId: string, plan: TemplatePlan) => void;
  updatePage: (id: string, patch: Partial<Page>) => void;
  deletePage: (id: string) => void;          // soft delete -> papelera
  restorePage: (id: string) => void;
  permanentlyDelete: (id: string) => void;
  emptyTrash: () => void;
  toggleFavorite: (id: string) => void;
  movePage: (id: string, newParentId: string | null, index?: number) => void;
  duplicatePage: (id: string) => string | null;
  setExpanded: (id: string, value: boolean) => void;

  // comentarios (blockId ancla el comentario a un bloque; omitido = de página)
  addComment: (pageId: string, body: string, blockId?: string) => void;
  deleteComment: (pageId: string, commentId: string) => void;
  toggleResolveComment: (pageId: string, commentId: string) => void;

  // recordatorios
  addReminder: (r: Omit<Reminder, "id" | "createdAt">) => string;
  updateReminder: (id: string, patch: Partial<Reminder>) => void;
  deleteReminder: (id: string) => void;

  // ajustes
  updateSettings: (patch: Partial<WorkspaceSettings>) => void;

  // importación completa del workspace (Ajustes > Data)
  importWorkspace: (state: WorkspaceState) => void;

  // historial de versiones de página
  saveVersion: (pageId: string, auto?: boolean) => void;
  restoreVersion: (pageId: string, versionId: string) => void;
  deleteVersion: (pageId: string, versionId: string) => void;

  // bloques
  setBlocks: (pageId: string, blocks: Block[]) => void;
  updateBlock: (pageId: string, blockId: string, patch: Partial<Block>) => void;
  insertBlock: (pageId: string, afterBlockId: string | null,
                block?: Partial<Block> & { type?: BlockType }) => string;
  deleteBlock: (pageId: string, blockId: string) => void;
  moveBlock: (pageId: string, fromIndex: number, toIndex: number) => void;

  // base de datos
  addRow: (pageId: string, patch?: Partial<DbRow>) => string;
  updateCell: (pageId: string, rowId: string, propertyId: string, value: unknown) => void;
  deleteRow: (pageId: string, rowId: string) => void;
  addProperty: (pageId: string, prop?: Partial<DbProperty>) => void;
  updateProperty: (pageId: string, propId: string, patch: Partial<DbProperty>) => void;
  deleteProperty: (pageId: string, propId: string) => void;
  addView: (pageId: string, view: Partial<DbView>) => void;
  updateView: (pageId: string, viewId: string, patch: Partial<DbView>) => void;
  deleteView: (pageId: string, viewId: string) => void;
  setDbLocked: (pageId: string, locked: boolean) => void;

  // plantillas de fila
  addRowFromTemplate: (pageId: string, templateId: string) => string;
  saveRowAsTemplate: (pageId: string, rowId: string, name: string) => void;
  deleteRowTemplate: (pageId: string, templateId: string) => void;

  // bloques sincronizados
  setSyncedBlocks: (key: string, blocks: Block[]) => void;

  resetWorkspace: () => void;
}

export function applyRemotePatch(state: Pick<WorkspaceState, "pages" | "rootOrder" | "syncedBlocks" | "settings" | "reminders">, patch: RemotePatch) {
  let pages = state.pages;
  let rootOrder = state.rootOrder;
  if (patch.pages && Object.keys(patch.pages).length) {
    pages = { ...pages };
    for (const [id, page] of Object.entries(patch.pages)) {
      if (page === null) delete pages[id]; else pages[id] = page;
      if (!page || page.isDeleted || page.parentId !== null) rootOrder = rootOrder.filter((key) => key !== id);
      else if (!rootOrder.includes(id)) rootOrder = [...rootOrder, id];
    }
  }
  return {
    pages, rootOrder: patch.rootOrder ?? rootOrder,
    ...(patch.syncedBlocks ? { syncedBlocks: patch.syncedBlocks } : {}),
    ...(patch.settings ? { settings: { ...DEFAULT_SETTINGS, ...patch.settings } } : {}),
    ...(patch.reminders ? { reminders: patch.reminders } : {}),
  };
}

function cleanPage(page: Page): Page {
  return {
    ...page, blocks: sanitizeBlocks(page.blocks),
    ...(page.database ? { database: { ...page.database, rowTemplates: page.database.rowTemplates?.map((t) => ({ ...t, blocks: sanitizeBlocks(t.blocks) })) } } : {}),
    ...(page.versions ? { versions: page.versions.map((v) => ({ ...v, blocks: sanitizeBlocks(v.blocks) })) } : {}),
  };
}

export const useStore = create<Store>()(persist((set, get) => {
  const mutate = (id: string, fn: (page: Page) => Page) => set((state) => {
    const page = state.pages[id];
    if (!page) return state;
    const next = fn(page);
    return next === page ? state : { pages: { ...state.pages, [id]: next } };
  });
  const attach = (page: Page, pages: Record<string, Page> = { [page.id]: page }) => set((state) => ({
    pages: { ...state.pages, ...pages },
    rootOrder: page.parentId === null ? [...state.rootOrder, page.id] : state.rootOrder,
    expanded: page.parentId ? { ...state.expanded, [page.parentId]: true } : state.expanded,
  }));
  const addRowResult = (id: string, result: ReturnType<typeof dm.addRow>) => {
    if (!result) return "";
    const settings = get().settings ?? DEFAULT_SETTINGS;
    const rowPage = { ...result.rowPage, smallText: settings.smallTextDefault, fullWidth: settings.fullWidthDefault, font: settings.defaultFont };
    set((state) => ({ pages: { ...state.pages, [id]: result.page, [rowPage.id]: rowPage }, expanded: { ...state.expanded, [id]: true } }));
    return result.rowId;
  };
  return {
    ...seedWorkspace(), expanded: {}, syncWorkspaceId: null, syncUserId: null,
    persistInitialWorkspace: () => {
      try {
        if (!localStorage.getItem("colabora-workspace")) set({});
      } catch { /* Storage can be unavailable; the workspace remains usable in memory. */ }
    },
    setSyncWorkspaceId: (id, userId = null) => set({ syncWorkspaceId: id, syncUserId: userId }),
    applyRemotePages: (patch) => set((state) => applyRemotePatch(state, {
      ...patch,
      ...(patch.pages ? { pages: Object.fromEntries(Object.entries(patch.pages).map(([id, page]) => [id, page ? cleanPage(page) : null])) } : {}),
    })),
    createPage: (parentId = null, patch = {}) => {
      const settings = get().settings ?? DEFAULT_SETTINGS;
      const page = cleanPage(makePage({ parentId, smallText: settings.smallTextDefault, fullWidth: settings.fullWidthDefault, font: settings.defaultFont !== "default" ? settings.defaultFont : undefined, ...patch }));
      attach(page);
      return page.id;
    },
    createDatabasePage: (parentId = null) => {
      const page = makePage({ parentId, title: "Untitled Database", icon: "🗃️", blocks: [], database: createDatabase() });
      attach(page);
      return page.id;
    },
    createPageFromTemplate: (plan, parentId = null) => {
      const result = materializeTemplate(plan, parentId);
      attach(result.page, result.pages);
      return result.page.id;
    },
    applyTemplate: (pageId, plan) => {
      const old = get().pages[pageId];
      if (!old) return;
      const result = materializeTemplate(plan, old.parentId);
      const children = Object.fromEntries(Object.values(result.pages).filter((p) => p.id !== result.page.id).map((p) => [p.id, { ...p, parentId: pageId }]));
      const database = result.page.database ? { ...result.page.database, properties: result.page.database.properties.map((p) => p.relationDbId === result.page.id ? { ...p, relationDbId: pageId } : p) } : old.database;
      set((state) => ({ pages: { ...state.pages, ...children, [pageId]: pm.touch({ ...old, title: old.title || plan.title, icon: old.icon ?? plan.icon, blocks: result.page.blocks, database }) } }));
    },
    updatePage: (id, patch) => mutate(id, (page) => pm.touch({ ...page, ...patch, ...(patch.blocks ? { blocks: sanitizeBlocks(patch.blocks) } : {}), ...(patch.database ? { database: cleanPage({ ...page, database: patch.database }).database } : {}) })),
    deletePage: (id) => set((state) => !state.pages[id] ? state : ({ pages: pm.softDeleteTree(state.pages, id, Date.now()), rootOrder: state.rootOrder.filter((key) => key !== id) })),
    restorePage: (id) => set((state) => {
      if (!state.pages[id]) return state;
      const pages = pm.restoreTree(state.pages, id, Date.now());
      return { pages, rootOrder: pages[id].parentId === null && !state.rootOrder.includes(id) ? [...state.rootOrder, id] : state.rootOrder };
    }),
    permanentlyDelete: (id) => { const ids = collectSubtreeFileIds(id); set((state) => !state.pages[id] ? state : ({ pages: pm.purgeTree(state.pages, id), rootOrder: state.rootOrder.filter((key) => key !== id) })); scheduleBlobGc(ids); },
    emptyTrash: () => { const ids = collectTrashFileIds(); set((state) => ({ pages: Object.fromEntries(Object.entries(state.pages).filter(([, page]) => !page.isDeleted)) })); scheduleBlobGc(ids); },
    toggleFavorite: (id) => mutate(id, (page) => pm.touch({ ...page, isFavorite: !page.isFavorite })),
    movePage: (id, parentId, index) => set((state) => {
      const next = pm.moveInTree(state.pages, state.rootOrder, id, parentId, index);
      return next.pages === state.pages ? state : { ...next, expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded };
    }),
    duplicatePage: (id) => {
      const result = pm.duplicateDeep(get().pages, id);
      if (!result.newId) return null;
      const copy = result.pages[result.newId];
      set((state) => ({ pages: result.pages, rootOrder: copy.parentId === null ? [...state.rootOrder, copy.id] : state.rootOrder }));
      return copy.id;
    },
    setExpanded: (id, value) => set((state) => ({ expanded: { ...state.expanded, [id]: value } })),
    addComment: (pageId, body, blockId) => {
      if (!body.trim()) return;
      const user = useAuthStore.getState().user;
      mutate(pageId, (page) => pm.touch({ ...page, comments: [...(page.comments ?? []), {
        id: newId(), body: body.trim(), ...(blockId ? { blockId, anchorId: blockId } : {}),
        authorId: user?.id ?? "local", authorType: "human", author: user ? user.user_metadata.full_name || user.email || "You" : "You (this device)", createdAt: Date.now(), resolved: false,
      }] }));
    },
    deleteComment: (pageId, id) => mutate(pageId, (page) => pm.touch({ ...page, comments: (page.comments ?? []).filter((c) => c.id !== id) })),
    toggleResolveComment: (pageId, id) => mutate(pageId, (page) => pm.touch({ ...page, comments: (page.comments ?? []).map((c) => c.id === id ? { ...c, resolved: !c.resolved } : c) })),
    addReminder: (reminder) => {
      const id = newId();
      set((state) => ({ reminders: [...(state.reminders ?? []), { ...reminder, id, createdAt: Date.now() }] }));
      return id;
    },
    updateReminder: (id, patch) => set((state) => ({ reminders: (state.reminders ?? []).map((r) => r.id === id ? { ...r, ...patch } : r) })),
    deleteReminder: (id) => set((state) => ({ reminders: (state.reminders ?? []).filter((r) => r.id !== id) })),
    updateSettings: (patch) => set((state) => ({ settings: { ...DEFAULT_SETTINGS, ...state.settings, ...patch } })),
    importWorkspace: (state) => set({ pages: Object.fromEntries(Object.entries(state.pages).map(([id, p]) => [id, cleanPage(p)])), rootOrder: state.rootOrder, expanded: state.expanded ?? {}, syncedBlocks: Object.fromEntries(Object.entries(state.syncedBlocks ?? {}).map(([id, blocks]) => [id, sanitizeBlocks(blocks)])), reminders: state.reminders ?? [], settings: state.settings ? { ...DEFAULT_SETTINGS, ...state.settings } : undefined }),
    resetWorkspace: () => set({ ...seedWorkspace(), expanded: {}, syncedBlocks: {}, reminders: [] }),
    saveVersion: (pageId, auto = false) => mutate(pageId, (page) => {
      const last = page.versions?.[0];
      if (last && last.title === page.title && JSON.stringify(last.blocks) === JSON.stringify(page.blocks) && JSON.stringify(last.database) === JSON.stringify(page.database)) return page;
      const user = useAuthStore.getState().user;
      const version = { id: newId(), createdAt: Date.now(), title: page.title, blocks: page.blocks, database: page.database, auto, author: { id: user?.id ?? "local", type: "human" as const, name: user?.user_metadata.full_name || user?.email || "You (this device)" } };
      return pm.touch({ ...page, versions: [version, ...(page.versions ?? [])].slice(0, VERSION_CAP) });
    }),
    restoreVersion: (pageId, versionId) => mutate(pageId, (page) => {
      const version = page.versions?.find((v) => v.id === versionId);
      if (!version) return page;
      const current = { id: newId(), createdAt: Date.now(), title: page.title, blocks: page.blocks, database: page.database, auto: true };
      const last = page.versions?.[0];
      const needsCurrent = !last || last.title !== page.title || JSON.stringify(last.blocks) !== JSON.stringify(page.blocks) || JSON.stringify(last.database) !== JSON.stringify(page.database);
      return pm.touch({ ...page, title: version.title, blocks: sanitizeBlocks(version.blocks), database: version.database, versions: [{ ...version, createdAt: Date.now() }, ...(needsCurrent ? [current] : []), ...(page.versions ?? []).filter((v) => v.id !== versionId)].slice(0, VERSION_CAP) });
    }),
    deleteVersion: (pageId, id) => mutate(pageId, (page) => pm.touch({ ...page, versions: (page.versions ?? []).filter((v) => v.id !== id) })),
    setBlocks: (pageId, blocks) => mutate(pageId, (page) => pm.touch({ ...page, blocks: blocks.map((block) => page.blocks.includes(block) ? block : sanitizeBlocks([block])[0]) })),
    updateBlock: (pageId, blockId, patch) => mutate(pageId, (page) => pm.touch({ ...page, blocks: page.blocks.map((block) => block.id === blockId ? sanitizeBlocks([{ ...block, ...patch, attr: { by: "human", id: get().syncUserId ?? "local", at: Date.now() } }])[0] : block) })),
    insertBlock: (pageId, afterId, patch = {}) => {
      const block = sanitizeBlocks([createBlock(patch.type ?? "paragraph", patch)])[0];
      mutate(pageId, (page) => {
        const blocks = [...page.blocks], index = afterId === null ? blocks.length - 1 : blocks.findIndex((b) => b.id === afterId);
        blocks.splice(index + 1, 0, block);
        return pm.touch({ ...page, blocks });
      });
      return block.id;
    },
    deleteBlock: (pageId, id) => mutate(pageId, (page) => {
      const blocks = page.blocks.filter((b) => b.id !== id);
      return pm.touch({ ...page, blocks: blocks.length ? blocks : [createBlock()] });
    }),
    moveBlock: (pageId, from, to) => mutate(pageId, (page) => {
      if (from < 0 || from >= page.blocks.length || to < 0 || to > page.blocks.length) return page;
      const blocks = [...page.blocks];
      blocks.splice(to, 0, blocks.splice(from, 1)[0]);
      return pm.touch({ ...page, blocks });
    }),
    addRow: (pageId, patch = {}) => {
      const page = get().pages[pageId];
      return page ? addRowResult(pageId, dm.addRow(page, patch)) : "";
    },
    updateCell: (pageId, rowId, propertyId, value) => set((state) => {
      const page = state.pages[pageId];
      if (!page) return state;
      const result = dm.updateCell(page, rowId, propertyId, value);
      if (result.page === page) return state;
      const pages = { ...state.pages, [pageId]: result.page };
      const rowPageId = page.database?.rows.find((r) => r.id === rowId)?.pageId;
      if (rowPageId && pages[rowPageId] && result.rowPagePatch) pages[rowPageId] = pm.touch({ ...pages[rowPageId], ...result.rowPagePatch });
      return { pages };
    }),
    deleteRow: (pageId, rowId) => set((state) => {
      const page = state.pages[pageId];
      if (!page) return state;
      const result = dm.deleteRow(page, rowId);
      if (result.page === page) return state;
      const pages = { ...state.pages, [pageId]: result.page };
      return { pages: result.rowPageId ? pm.softDeleteTree(pages, result.rowPageId, Date.now()) : pages };
    }),
    addProperty: (id, prop) => mutate(id, (page) => dm.addProperty(page, prop)),
    updateProperty: (id, propId, patch) => mutate(id, (page) => dm.updateProperty(page, propId, patch)),
    deleteProperty: (id, propId) => mutate(id, (page) => dm.deleteProperty(page, propId)),
    addView: (id, view) => mutate(id, (page) => dm.addView(page, view)),
    updateView: (id, viewId, patch) => mutate(id, (page) => dm.updateView(page, viewId, patch)),
    deleteView: (id, viewId) => mutate(id, (page) => dm.deleteView(page, viewId)),
    setDbLocked: (id, locked) => mutate(id, (page) => dm.setDbLocked(page, locked)),
    addRowFromTemplate: (id, templateId) => {
      const page = get().pages[id];
      return page ? addRowResult(id, dm.addRowFromTemplate(page, templateId)) : "";
    },
    saveRowAsTemplate: (id, rowId, name) => mutate(id, (page) => {
      const row = page.database?.rows.find((r) => r.id === rowId);
      return dm.saveRowAsTemplate(page, rowId, name, row ? get().pages[row.pageId] : undefined);
    }),
    deleteRowTemplate: (id, templateId) => mutate(id, (page) => dm.deleteRowTemplate(page, templateId)),
    setSyncedBlocks: (key, blocks) => set((state) => ({ syncedBlocks: { ...state.syncedBlocks, [key]: sanitizeBlocks(blocks) } })),
  };
}, {
  name: "colabora-workspace", version: 1,
  onRehydrateStorage: () => (state) => { mark("colabora:hydrate:end"); if (state) recordHydration(pageDataSizes(state.pages)); },
  partialize: (state): WorkspaceState & SyncState => ({
    pages: Object.fromEntries(Object.entries(state.pages).filter(([id]) => !foreignPageIds.has(id))),
    rootOrder: state.rootOrder, expanded: state.expanded, syncedBlocks: state.syncedBlocks,
    reminders: state.reminders, settings: state.settings, syncWorkspaceId: state.syncWorkspaceId, syncUserId: state.syncUserId,
  }),
  migrate: (persisted) => persisted as Store,
}));

export function getChildren(pages: Record<string, Page>, parentId: string | null): Page[] {
  return Object.values(pages).filter((p) => p.parentId === parentId && !p.isDeleted).sort((a, b) => a.createdAt - b.createdAt);
}
export function getBreadcrumb(pages: Record<string, Page>, id: string): Page[] {
  const chain: Page[] = [], seen = new Set<string>();
  let current: string | null = id;
  while (current && pages[current] && !seen.has(current)) {
    seen.add(current); chain.unshift(pages[current]); current = pages[current].parentId;
  }
  return chain;
}
export function getFavorites(pages: Record<string, Page>): Page[] {
  return Object.values(pages).filter((p) => p.isFavorite && !p.isDeleted);
}
export function getTrash(pages: Record<string, Page>): Page[] {
  return Object.values(pages).filter((p) => p.isDeleted).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function searchPages(pages: Record<string, Page>, query: string): Page[] {
  const needle = query.trim().toLowerCase();
  const text = (blocks: Block[]): string => blocks.map((b) => stripHtml(b.html) + (b.columns ? b.columns.map((c) => text(c.blocks)).join(" ") : "")).join(" ");
  return Object.values(pages).filter((p) => !p.isDeleted && (p.title.toLowerCase().includes(needle) || text(p.blocks).toLowerCase().includes(needle))).sort((a, b) => b.updatedAt - a.updatedAt);
}
