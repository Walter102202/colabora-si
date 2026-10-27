import { create } from "zustand";
import type { RealtimeChannel, SupabaseClient, User } from "@supabase/supabase-js";
import type { Block, BlockAttr, Page, Reminder, WorkspaceState } from "@/lib/types";
import { applyOps, applyWorkspaceOps, diffPageToOps, type OpResult, type PageOp, type WorkspaceOp } from "@/lib/pageOps";
import { IndexedDbQueue, MemoryQueue } from "@/lib/opsQueue";
import { pageFromRow, mergePageDecision, mergeReminders, type PageRow, type WorkspaceRow, type ReminderRow } from "@/lib/syncMerge";
import { getSupabase } from "@/lib/supabase";
import { useStore, type RemotePatch, type Store } from "@/lib/store";
import { pauseHistory, resumeHistory, rebaseHistory } from "@/lib/history";
import { foreignPageIds } from "@/lib/foreignPages";
import { DEFAULT_SETTINGS } from "@/lib/factories";
import { useBlockConflicts, type BlockConflict } from "@/lib/syncConflicts";

export const CLIENT_TAG = Math.random().toString(36).slice(2) + Date.now().toString(36);
const DEBOUNCE_MS = 1500, MAX_RETRIES = 5, ACTIVE_EDIT_MS = 2000, DELETE_ECHO_TTL_MS = 120000;
const PAGE_COLS = "id,parent_id,data,deleted_at,updated_at,revision,last_edited_by,last_edited_by_type,last_edit_run_id";
const WS_COLS = "id,name,root_order,synced_blocks,settings,updated_at,revision";
const REMINDER_COLS = "id,page_id,block_id,body,remind_at,notified,deleted_at";
export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";
export const useSyncStatus = create<{ status: SyncStatus; lastSyncedAt: number | null; error: string | null }>(() => ({ status: "idle", lastSyncedAt: null, error: null }));
const setStatus = (status: SyncStatus, error: string | null = null) => useSyncStatus.setState(status === "synced" ? { status, lastSyncedAt: Date.now(), error } : { status, error });
export type ConflictChoice = "merge" | "server" | "local";
export interface ConflictPrompt { serverPageCount: number; localPageCount: number; resolve: (choice: ConflictChoice) => void }
export const useSyncConflict = create<{ prompt: ConflictPrompt | null }>(() => ({ prompt: null }));
const SYNC_CANCELLED = Symbol("sync-cancelled");
let conflictReject: (() => void) | null = null;
function askConflictChoice(serverPageCount: number, localPageCount: number): Promise<ConflictChoice> {
  return new Promise((resolve, reject) => {
    conflictReject = () => reject(SYNC_CANCELLED);
    useSyncConflict.setState({ prompt: { serverPageCount, localPageCount, resolve: (choice) => { conflictReject = null; useSyncConflict.setState({ prompt: null }); resolve(choice); } } });
  });
}

type OpsReply = { revision: number; results: OpResult[] };
interface PageSyncAdapter {
  getPage: (id: string) => Page | undefined;
  apply: (id: string, page: Page | null, rebase?: boolean) => void;
  send: (id: string, ops: PageOp[], client: string, key: string) => Promise<OpsReply>;
  read: (id: string) => Promise<PageRow | null>;
  conflict: (pageId: string, conflict: BlockConflict) => void;
  beforeRebase?: (id: string) => void;
}
export class PageSyncEngine {
  constructor(readonly queue: MemoryQueue, readonly client: string, private actor: BlockAttr, private adapter: PageSyncAdapter) {}
  receive(row: PageRow, force = false): boolean {
    if (!force && row.data?._client === this.client) { this.queue.setRevision(row.id, row.revision); return false; }
    if (row.revision < this.queue.getRevision(row.id) || (!force && row.revision === this.queue.getRevision(row.id))) return false;
    this.queue.setRevision(row.id, row.revision);
    if (this.queue.isDeleted(row.id)) return false;
    const remote = pageFromRow(row);
    if (!remote) { if (row.deleted_at) { this.queue.clearPage(row.id); this.adapter.apply(row.id, null); } return !!row.deleted_at; }
    if (this.queue.peek(row.id).length) this.adapter.beforeRebase?.(row.id);
    const pending = this.queue.peek(row.id);
    this.adapter.apply(row.id, pending.length ? { ...applyOps(remote, pending, this.actor).page, revision: row.revision } : remote, row.data?._client !== this.client);
    return true;
  }
  async flushPage(id: string): Promise<void> {
    while (this.queue.peek(id).length) {
      const ops = this.queue.peek(id).slice(0, 200), key = this.queue.batchKey(id, ops.length);
      await this.queue.settled();
      const response = await this.adapter.send(id, ops, this.client, key);
      const revisions = new Map<string, number>(), seen = new Set<string>();
      for (const result of response.results) {
        const op = ops[result.i]; if (!op) continue;
        const itemId = "id" in op ? op.id : "rowId" in op ? op.rowId : op.op === "insert_block" ? op.block.id : op.op === "db_row_add" ? op.row.id : null;
        if (result.conflict && itemId && !seen.has(itemId)) this.adapter.conflict(id, { ...result.conflict, at: Date.now(), ...(op.op === "db_cell_set" ? { propertyId: op.propertyId } : {}) });
        if (itemId && result.rev !== undefined) revisions.set(itemId, result.rev);
        if (itemId) seen.add(itemId);
      }
      this.queue.ack(id, ops.length); this.queue.setRevision(id, response.revision); this.queue.rebaseRevisions(id, revisions);
      const local = this.adapter.getPage(id);
      if (local) {
        const patchBlocks = (blocks: Block[]): Block[] => blocks.map((block) => {
          const rev = revisions.get(block.id), columns = block.columns?.map((c) => ({ ...c, blocks: patchBlocks(c.blocks) }));
          return rev === undefined && !columns ? block : { ...block, ...(rev === undefined ? {} : { rev }), ...(columns ? { columns } : {}) };
        });
        this.adapter.apply(id, { ...local, revision: response.revision, blocks: patchBlocks(local.blocks), ...(local.database ? { database: { ...local.database, rows: local.database.rows.map((r) => revisions.has(r.id) ? { ...r, rev: revisions.get(r.id) } : r) } } : {}) }, false);
      }
      await this.queue.settled();
    }
    const row = await this.adapter.read(id);
    if (row) this.receive(row, true);
  }
}

let started = false, ready = false, currentUserId: string | null = null, wsId: string | null = null, generation = 0;
let queue: IndexedDbQueue | null = null, engine: PageSyncEngine | null = null, channel: RealtimeChannel | null = null;
let unsubStore: (() => void) | null = null, last: Store | null = null, applyingRemote = false, pushing = false, dirty = false, attempts = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null, retryTimer: ReturnType<typeof setTimeout> | null = null, deferTimer: ReturnType<typeof setTimeout> | null = null;
let lastWorkspaceSeen = 0, lastWorkspaceRevision = 0, pendingRetryUser: User | null = null;
const known = new Set<string>(), lastSeen = new Map<string, number>(), lastEditAt = new Map<string, number>(), recentlyDeleted = new Map<string, number>(), deferred = new Map<string, PageRow>();
function applyRemote(patch: RemotePatch, rebase = true): void {
  applyingRemote = true; pauseHistory();
  try { useStore.getState().applyRemotePages(patch); }
  finally { resumeHistory(); applyingRemote = false; }
  if (rebase) rebaseHistory(patch); last = useStore.getState();
}
function scheduleFlush(ms = DEBOUNCE_MS): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; void flush(); }, ms);
}
function workspaceDiff(before: WorkspaceState, after: WorkspaceState): WorkspaceOp[] {
  const ops: WorkspaceOp[] = [];
  if (before.rootOrder !== after.rootOrder) ops.push({ op: "set_root_order", rootOrder: after.rootOrder });
  if (before.settings !== after.settings) ops.push({ op: "set_settings", patch: after.settings ?? DEFAULT_SETTINGS });
  for (const key of new Set([...Object.keys(before.syncedBlocks ?? {}), ...Object.keys(after.syncedBlocks ?? {})])) {
    if (before.syncedBlocks?.[key] !== after.syncedBlocks?.[key]) ops.push({ op: "synced_set", key, blocks: after.syncedBlocks?.[key] ?? null });
  }
  return ops;
}
function onStoreChange(state: Store): void {
  if (applyingRemote || !last || !queue) { last = state; return; }
  const before = last; last = state;
  if (before.pages !== state.pages) for (const id of new Set([...Object.keys(before.pages), ...Object.keys(state.pages)])) {
    if (foreignPageIds.has(id) || before.pages[id] === state.pages[id]) continue;
    lastEditAt.set(id, Date.now());
    if (!state.pages[id]) queue.markDeleted(id);
    else if (before.pages[id]) queue.enqueue(id, diffPageToOps(before.pages[id], state.pages[id]));
  }
  const workspaceOps = workspaceDiff(before, state); if (workspaceOps.length) queue.enqueueWorkspace(workspaceOps);
  if (before.pages !== state.pages || before.rootOrder !== state.rootOrder || before.settings !== state.settings || before.syncedBlocks !== state.syncedBlocks || before.reminders !== state.reminders) scheduleFlush();
}
async function fetchAllPages(sb: SupabaseClient): Promise<PageRow[]> {
  const rows: PageRow[] = [];
  for (let from = 0; ; from += 500) {
    const result = await sb.from("pages").select(PAGE_COLS).eq("workspace_id", wsId).order("id").range(from, from + 499);
    if (result.error) throw result.error;
    rows.push(...result.data as PageRow[]); if (result.data.length < 500) return rows;
  }
}
async function readPage(sb: SupabaseClient, id: string): Promise<PageRow | null> {
  const { data, error } = await sb.from("pages").select(PAGE_COLS).eq("workspace_id", wsId).eq("id", id).maybeSingle();
  if (error) throw error; return data as PageRow | null;
}
async function insertPage(sb: SupabaseClient, page: Page): Promise<void> {
  const count = queue!.peek(page.id).length;
  const stamp = (blocks: Block[]): Block[] => blocks.map((b) => ({ ...b, rev: b.rev ?? 1, ...(b.columns ? { columns: b.columns.map((c) => ({ ...c, blocks: stamp(c.blocks) })) } : {}) }));
  const content = { ...page, blocks: stamp(page.blocks), ...(page.database ? { database: { ...page.database, rows: page.database.rows.map((r) => ({ ...r, rev: r.rev ?? 1 })) } } : {}), _client: CLIENT_TAG };
  const { data, error } = await sb.from("pages").insert({ id: page.id, workspace_id: wsId, parent_id: page.parentId, data: content, deleted_at: page.isDeleted ? new Date().toISOString() : null }).select(PAGE_COLS).single();
  if (error) {
    if (error.code !== "23505") throw error;
    const row = await readPage(sb, page.id); if (!row) throw error;
    known.add(page.id); engine!.receive(row, true); return;
  }
  known.add(page.id); queue!.ack(page.id, count); queue!.setRevision(page.id, data.revision); lastSeen.set(page.id, Date.parse(data.updated_at));
  engine!.receive(data as PageRow, true);
}
async function tombstonePage(sb: SupabaseClient, id: string): Promise<void> {
  recentlyDeleted.set(id, Date.now());
  const { data, error } = await sb.from("pages").update({ data: null, parent_id: null, deleted_at: new Date().toISOString() }).eq("workspace_id", wsId).eq("id", id).select("revision,updated_at").maybeSingle();
  if (error) { recentlyDeleted.delete(id); throw error; }
  queue!.clearPage(id); if (data) { queue!.setRevision(id, data.revision); lastSeen.set(id, Date.parse(data.updated_at)); }
}
async function pushReminders(sb: SupabaseClient, reminders: Reminder[]): Promise<void> {
  const { data: remote, error: readError } = await sb.from("reminders").select("id").eq("workspace_id", wsId).eq("user_id", currentUserId).is("deleted_at", null);
  if (readError) throw readError;
  const removed = (remote ?? []).filter((r) => !reminders.some((local) => local.id === r.id)).map((r) => r.id);
  if (removed.length) { const { error } = await sb.from("reminders").update({ deleted_at: new Date().toISOString() }).in("id", removed).eq("user_id", currentUserId); if (error) throw error; }
  if (reminders.length) {
    const { error } = await sb.from("reminders").upsert(reminders.map((r) => ({ id: r.id, workspace_id: wsId, user_id: currentUserId, page_id: r.pageId || null, block_id: r.blockId ?? null, body: r.text, remind_at: new Date(Number.isNaN(Date.parse(r.date)) ? Date.now() : Date.parse(r.date)).toISOString(), notified: !!r.notified, deleted_at: null })));
    if (error) throw error;
  }
}
async function flushWorkspace(sb: SupabaseClient): Promise<void> {
  while (queue!.peekWorkspace().length) {
    const ops = queue!.peekWorkspace().slice(0, 200);
    const { data, error } = await sb.rpc("apply_workspace_ops", { p_workspace_id: wsId, p_ops: ops, p_client: CLIENT_TAG });
    if (error) throw error;
    queue!.ackWorkspace(ops.length); lastWorkspaceRevision = Math.max(lastWorkspaceRevision, data.revision);
  }
}
export async function flush(): Promise<void> {
  const sb = getSupabase(); if (!started || !ready || !wsId || !queue || !engine || !sb) return;
  if (pushing) { dirty = true; return; }
  if (!navigator.onLine) { setStatus("offline"); return; }
  const token = generation; pushing = true; setStatus("syncing");
  try {
    const snapshot = useStore.getState();
    for (const page of Object.values(snapshot.pages)) if (!foreignPageIds.has(page.id) && !known.has(page.id) && !page.isDeleted) { await insertPage(sb, page); if (token !== generation) return; }
    for (const id of queue.pageIds()) {
      if (foreignPageIds.has(id)) continue;
      if (queue.isDeleted(id)) await tombstonePage(sb, id);
      else if (known.has(id) && queue.peek(id).length) await engine.flushPage(id);
      if (token !== generation) return;
    }
    await flushWorkspace(sb); await pushReminders(sb, snapshot.reminders ?? []); await queue.settled();
    attempts = 0; setStatus("synced");
  } catch (error) {
    if (token !== generation) return;
    attempts++; setStatus(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : JSON.stringify(error));
    if (attempts <= MAX_RETRIES) retryTimer = setTimeout(() => void flush(), Math.min(1000 * 2 ** attempts, 30000));
  } finally { if (token === generation) { pushing = false; if (dirty) { dirty = false; scheduleFlush(300); } } }
}
function handlePageRow(row: PageRow): void {
  if (!engine || !queue) return;
  const ms = Date.parse(row.updated_at); lastSeen.set(row.id, Math.max(lastSeen.get(row.id) ?? 0, ms)); known.add(row.id);
  if (row.data?._client === CLIENT_TAG) { engine.receive(row); return; }
  if (row.revision <= queue.getRevision(row.id)) return;
  if (!row.data && row.deleted_at) {
    if (Date.now() - (recentlyDeleted.get(row.id) ?? 0) < DELETE_ECHO_TTL_MS) { queue.setRevision(row.id, row.revision); return; }
    deferred.delete(row.id); engine.receive(row); return;
  }
  if (Date.now() - (lastEditAt.get(row.id) ?? 0) < ACTIVE_EDIT_MS) {
    if ((deferred.get(row.id)?.revision ?? 0) < row.revision) deferred.set(row.id, row);
    if (!deferTimer) deferTimer = setTimeout(() => { deferTimer = null; const rows = [...deferred.values()]; deferred.clear(); rows.forEach(handlePageRow); }, ACTIVE_EDIT_MS + 500);
    return;
  }
  if (!row.data) { const sb = getSupabase(); if (sb) void readPage(sb, row.id).then((fresh) => { if (fresh) handlePageRow(fresh); }); return; }
  engine.receive(row);
}
function handleWorkspaceRow(row: WorkspaceRow, force = false): void {
  if (!queue || (!force && row.revision <= lastWorkspaceRevision)) return;
  lastWorkspaceRevision = row.revision; lastWorkspaceSeen = Date.parse(row.updated_at);
  const s = useStore.getState(), localOnly = s.rootOrder.filter((id) => !known.has(id) && s.pages[id] && !s.pages[id].isDeleted && !row.root_order?.includes(id));
  const base = { ...s, rootOrder: [...(row.root_order ?? []), ...localOnly], syncedBlocks: row.synced_blocks ?? {}, settings: row.settings ?? DEFAULT_SETTINGS };
  const next = applyWorkspaceOps(base, queue.peekWorkspace());
  applyRemote({ rootOrder: next.rootOrder, syncedBlocks: next.syncedBlocks, settings: next.settings });
}
async function pullSince(): Promise<void> {
  const sb = getSupabase(); if (!sb || !wsId) return;
  const token = generation;
  try {
    const since = new Date(Math.max(0, lastWorkspaceSeen, ...lastSeen.values())).toISOString();
    const { data, error } = await sb.from("pages").select(PAGE_COLS).eq("workspace_id", wsId).gt("updated_at", since).order("updated_at");
    if (error) throw error; if (token !== generation) return;
    (data as PageRow[]).forEach(handlePageRow);
    const workspace = await sb.from("workspaces").select(WS_COLS).eq("id", wsId).maybeSingle();
    if (workspace.error) throw workspace.error;
    if (workspace.data && token === generation) handleWorkspaceRow(workspace.data as WorkspaceRow);
    if (token === generation) scheduleFlush(0);
  } catch { if (token === generation) setStatus(navigator.onLine ? "error" : "offline"); }
}
const online = () => { attempts = 0; if (pendingRetryUser) { const user = pendingRetryUser; pendingRetryUser = null; void initSync(user); } else { setStatus("syncing"); void pullSince(); } };
const offline = () => setStatus("offline");
function startRealtime(sb: SupabaseClient): void {
  const token = generation;
  channel = sb.channel(`workspace-${wsId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "pages", filter: `workspace_id=eq.${wsId}` }, (payload) => { if (token === generation) handlePageRow(payload.new as PageRow); })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pages", filter: `workspace_id=eq.${wsId}` }, (payload) => { if (token === generation) handlePageRow(payload.new as PageRow); })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "pages" }, (payload) => { if (token === generation && known.has(payload.old.id)) { queue?.clearPage(payload.old.id); applyRemote({ pages: { [payload.old.id]: null } }); } })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspaces", filter: `id=eq.${wsId}` }, (payload) => { if (token === generation) handleWorkspaceRow(payload.new as WorkspaceRow); })
    .subscribe((status) => { if (token !== generation) return; if (status === "SUBSCRIBED") void pullSince(); else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setStatus(navigator.onLine ? "error" : "offline"); });
}
function makeEngine(sb: SupabaseClient, user: User): PageSyncEngine {
  const token = generation;
  return new PageSyncEngine(queue!, CLIENT_TAG, { by: "human", id: user.id, at: Date.now() }, {
    getPage: (id) => useStore.getState().pages[id],
    apply: (id, page, rebase) => { if (token === generation) applyRemote({ pages: { [id]: page } }, rebase); },
    send: async (id, ops, client, key) => {
      if (token !== generation) throw SYNC_CANCELLED;
      const { data, error } = await sb.rpc("apply_page_ops", { p_page_id: id, p_ops: ops, p_client: client, p_idempotency_key: key });
      if (error) throw error; if (token !== generation) throw SYNC_CANCELLED;
      return data as OpsReply;
    },
    read: (id) => readPage(sb, id),
    conflict: (id, conflict) => { if (token === generation) useBlockConflicts.getState().add(id, conflict); },
    beforeRebase: (id) => { useStore.getState().saveVersion(id, true); },
  });
}
async function bootstrap(sb: SupabaseClient, user: User, token: number): Promise<void> {
  const initial = useStore.getState(), switched = !!initial.syncUserId && initial.syncUserId !== user.id;
  const linked = switched ? null : initial.syncWorkspaceId;
  let workspace: WorkspaceRow | null = null;
  if (linked) { const result = await sb.from("workspaces").select(WS_COLS).eq("id", linked).maybeSingle(); if (result.error) throw result.error; workspace = result.data as WorkspaceRow | null; }
  if (!workspace) {
    const owned = await sb.from("workspaces").select(WS_COLS).eq("owner_id", user.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (owned.error) throw owned.error; workspace = owned.data as WorkspaceRow | null;
    if (!workspace) { const joined = await sb.from("workspaces").select(WS_COLS).order("updated_at", { ascending: false }).limit(1).maybeSingle(); if (joined.error) throw joined.error; workspace = joined.data as WorkspaceRow | null; }
  }
  if (token !== generation) throw SYNC_CANCELLED;
  const meaningful = Object.values(initial.pages).some((p) => !p.isDeleted && !foreignPageIds.has(p.id) && p.updatedAt > p.createdAt);
  if (!workspace) {
    if (switched && meaningful && await askConflictChoice(0, Object.keys(initial.pages).length) === "server") applyRemote({ pages: Object.fromEntries(Object.keys(initial.pages).filter((id) => !foreignPageIds.has(id)).map((id) => [id, null])), rootOrder: [], reminders: [] });
    const s = useStore.getState();
    const created = await sb.from("workspaces").insert({ name: "My Workspace", owner_id: user.id, root_order: s.rootOrder, synced_blocks: s.syncedBlocks ?? {}, settings: s.settings ?? DEFAULT_SETTINGS }).select(WS_COLS).single();
    if (created.error) throw created.error; workspace = created.data as WorkspaceRow;
    const membership = await sb.from("workspace_members").insert({ workspace_id: workspace.id, user_id: user.id, role: "owner" }); if (membership.error) throw membership.error;
  }
  wsId = workspace.id;
  await openQueue(sb, user);
  if (token !== generation) throw SYNC_CANCELLED;
  const rows = await fetchAllPages(sb); if (token !== generation) throw SYNC_CANCELLED;
  rows.forEach((r) => { known.add(r.id); lastSeen.set(r.id, Date.parse(r.updated_at)); });
  let choice: ConflictChoice = !linked && !meaningful && rows.some((r) => r.data && !r.deleted_at) ? "server" : "merge";
  if (!linked && meaningful && (switched || rows.some((r) => r.data && !r.deleted_at))) choice = await askConflictChoice(rows.filter((r) => r.data && !r.deleted_at).length, Object.values(useStore.getState().pages).filter((p) => !p.isDeleted && !foreignPageIds.has(p.id)).length);
  if (token !== generation) throw SYNC_CANCELLED;
  const current = useStore.getState();
  if (choice === "server") {
    queue!.clearAll();
    const pages: Record<string, Page | null> = Object.fromEntries(Object.keys(current.pages).filter((id) => !foreignPageIds.has(id)).map((id) => [id, null]));
    rows.forEach((row) => { pages[row.id] = pageFromRow(row); queue!.setRevision(row.id, row.revision); });
    applyRemote({ pages, rootOrder: workspace.root_order ?? [], syncedBlocks: workspace.synced_blocks ?? {}, settings: workspace.settings ?? DEFAULT_SETTINGS, reminders: [] });
  } else if (choice === "local") {
    queue!.clearAll();
    for (const page of Object.values(current.pages)) if (!foreignPageIds.has(page.id) && known.has(page.id)) queue!.enqueue(page.id, [{ op: "replace_page", page, revision: page.revision ?? 0 }]);
    for (const row of rows) if (!current.pages[row.id]) queue!.markDeleted(row.id);
    queue!.enqueueWorkspace([{ op: "set_root_order", rootOrder: current.rootOrder }, { op: "set_settings", patch: current.settings ?? DEFAULT_SETTINGS }, ...Object.entries(current.syncedBlocks ?? {}).map(([key, blocks]): WorkspaceOp => ({ op: "synced_set", key, blocks }))]);
  } else {
    for (const row of rows) {
      if (queue!.isDeleted(row.id)) continue;
      const decision = mergePageDecision(current.pages[row.id], row, foreignPageIds.has(row.id));
      if (decision.kind === "push") queue!.enqueue(row.id, [{ op: "replace_page", page: decision.page, revision: row.revision }]);
      else engine!.receive(row, true);
    }
    handleWorkspaceRow(workspace, true);
    const s = useStore.getState(); if (JSON.stringify(s.rootOrder) !== JSON.stringify(workspace.root_order)) queue!.enqueueWorkspace([{ op: "set_root_order", rootOrder: s.rootOrder }]);
  }
  lastWorkspaceRevision = workspace.revision; lastWorkspaceSeen = Date.parse(workspace.updated_at);
  const reminders = await sb.from("reminders").select(REMINDER_COLS).eq("workspace_id", wsId).eq("user_id", user.id);
  if (reminders.error) throw reminders.error;
  const rem = mergeReminders(choice === "server" ? [] : useStore.getState().reminders ?? [], reminders.data as ReminderRow[], useStore.getState().reminders?.length ?? 0);
  if (rem.changed) applyRemote({ reminders: rem.merged });
  for (const page of Object.values(useStore.getState().pages)) if (!foreignPageIds.has(page.id) && !known.has(page.id) && !page.isDeleted) await insertPage(sb, page);
  useStore.getState().setSyncWorkspaceId(wsId, user.id); last = useStore.getState();
}
async function openQueue(sb: SupabaseClient, user: User): Promise<void> {
  if (queue) return;
  let owner = sessionStorage.getItem("colabora-sync-tab"); if (!owner) { owner = crypto.randomUUID(); sessionStorage.setItem("colabora-sync-tab", owner); }
  queue = new IndexedDbQueue(`${user.id}:${wsId}`, owner); await queue.ready;
  engine = makeEngine(sb, user); onStoreChange(useStore.getState());
  unsubStore = useStore.subscribe(onStoreChange);
}
export async function initSync(user: User): Promise<void> {
  if (typeof window === "undefined" || (started && currentUserId === user.id)) return;
  if (started) stopSync(); const sb = getSupabase(); if (!sb) return;
  started = true; currentUserId = user.id; last = useStore.getState(); const token = ++generation;
  setStatus("syncing"); window.addEventListener("online", online); window.addEventListener("offline", offline);
  try {
    const local = useStore.getState();
    if (local.syncUserId === user.id && local.syncWorkspaceId) {
      wsId = local.syncWorkspaceId; await openQueue(sb, user);
      for (const page of Object.values(local.pages)) if (page.revision || queue!.getRevision(page.id)) known.add(page.id);
      if (!navigator.onLine) { ready = true; startRealtime(sb); setStatus("offline"); return; }
    }
    if (navigator.locks) await navigator.locks.request("colabora-sync-bootstrap", () => bootstrap(sb, user, token)); else await bootstrap(sb, user, token);
    if (token !== generation) return;
    ready = true; startRealtime(sb); setStatus(navigator.onLine ? "synced" : "offline"); scheduleFlush(0);
  } catch (error) {
    if (error === SYNC_CANCELLED || token !== generation) return;
    if (queue && wsId) { ready = true; startRealtime(sb); setStatus(navigator.onLine ? "error" : "offline"); return; }
    stopSync(); pendingRetryUser = user; setStatus(navigator.onLine ? "error" : "offline", error instanceof Error ? error.message : JSON.stringify(error));
    window.addEventListener("online", online, { once: true });
    retryTimer = setTimeout(() => { if (navigator.onLine) online(); }, 3000);
  }
}
export function stopSync(): void {
  generation++; started = ready = false; currentUserId = wsId = null; pendingRetryUser = null;
  conflictReject?.(); conflictReject = null; useSyncConflict.setState({ prompt: null });
  window.removeEventListener("online", online); window.removeEventListener("offline", offline);
  if (debounceTimer) clearTimeout(debounceTimer); if (retryTimer) clearTimeout(retryTimer); if (deferTimer) clearTimeout(deferTimer);
  debounceTimer = retryTimer = deferTimer = null; unsubStore?.(); unsubStore = null;
  if (channel) void getSupabase()?.removeChannel(channel); channel = null;
  if (queue) void queue.close().catch(() => {}); queue = null; engine = null;
  last = null; pushing = dirty = applyingRemote = false; attempts = lastWorkspaceSeen = lastWorkspaceRevision = 0;
  known.clear(); lastSeen.clear(); lastEditAt.clear(); recentlyDeleted.clear(); deferred.clear(); setStatus("idle");
}
export async function forceFullPush(): Promise<void> {
  if (!started || !ready || !wsId || !queue || pushing) throw new Error("Sync is not ready");
  if (!window.confirm("Replace the cloud workspace with this device's copy? Pages that only exist in the cloud will be deleted.")) return;
  const sb = getSupabase(); if (!sb) throw new Error("Not connected");
  for (const row of await fetchAllPages(sb)) known.add(row.id);
  const s = useStore.getState(); queue.clearAll();
  for (const page of Object.values(s.pages)) if (!foreignPageIds.has(page.id) && known.has(page.id)) queue.enqueue(page.id, [{ op: "replace_page", page, revision: page.revision ?? 0 }]);
  for (const id of known) if (!s.pages[id]) queue.markDeleted(id);
  queue.enqueueWorkspace([{ op: "set_root_order", rootOrder: s.rootOrder }, { op: "set_settings", patch: s.settings ?? DEFAULT_SETTINGS }, ...Object.entries(s.syncedBlocks ?? {}).map(([key, blocks]): WorkspaceOp => ({ op: "synced_set", key, blocks }))]);
  await flush(); if (useSyncStatus.getState().status === "error") throw new Error("Sync failed");
}
export async function forceFullPull(): Promise<void> {
  const sb = getSupabase(); if (!started || !ready || !wsId || !queue || !sb || pushing) throw new Error("Sync is not ready");
  if (!window.confirm("Replace this device's workspace with the cloud copy? Unsynced local changes will be discarded.")) return;
  setStatus("syncing"); queue.clearAll();
  try {
    const rows = await fetchAllPages(sb), pages: Record<string, Page | null> = Object.fromEntries(Object.keys(useStore.getState().pages).filter((id) => !foreignPageIds.has(id)).map((id) => [id, null]));
    rows.forEach((row) => { pages[row.id] = pageFromRow(row); queue!.setRevision(row.id, row.revision); known.add(row.id); });
    applyRemote({ pages }); const workspace = await sb.from("workspaces").select(WS_COLS).eq("id", wsId).single();
    if (workspace.error) throw workspace.error; handleWorkspaceRow(workspace.data as WorkspaceRow, true); setStatus("synced");
  } catch (error) { setStatus(navigator.onLine ? "error" : "offline"); throw error; }
}
