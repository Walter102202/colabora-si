import { describe, expect, it } from "vitest";
import { localOnlyPages, mergePageDecision, mergeReminders, pageFromRow, reminderFromRow, type ReminderRow } from "@/lib/syncMerge";
import { liveRow, page, T, tombstoneRow } from "./fixtures";
import type { Reminder } from "@/lib/types";

const reminder = (id = "r1", notified = false): Reminder => ({ id, pageId: "a", text: "Ping", date: new Date(T).toISOString(), createdAt: T, notified });
const reminderRow = (id = "r1", patch: Partial<ReminderRow> = {}): ReminderRow => ({ id, page_id: "a", block_id: null, body: "Ping", remind_at: new Date(T).toISOString(), notified: false, deleted_at: null, ...patch });
describe("page merge", () => {
  it("A-7-1 null content", () => expect(pageFromRow(tombstoneRow("a", T))).toBeNull());
  it("A-7-2 page title without client tag", () => { const result = pageFromRow(liveRow("a", T, { title: "Hello" })); expect(result?.title).toBe("Hello"); expect(result).not.toHaveProperty("_client"); });
  it("A-7-6 unknown server page", () => expect(mergePageDecision(undefined, liveRow("a", T, { title: "New" }), false)).toMatchObject({ kind: "apply", page: { title: "New" } }));
  it("A-7-7 trash is not a purge", () => expect(mergePageDecision(page({ updatedAt: T - 1, isDeleted: true }), liveRow("a", T), false).kind).toBe("apply"));
  it.each([[8, T - 5000, "delete"], [9, T + 5000, "push"], [10, T, "delete"]] as const)("A-7-%s tombstone versus local timestamp", (_id, updatedAt, kind) => {
    const local = page({ updatedAt }); expect(mergePageDecision(local, tombstoneRow("a", T), false)).toEqual(kind === "push" ? { kind, page: local } : { kind, serverMs: T });
  });
  it("A-7-11 unknown tombstone", () => expect(mergePageDecision(undefined, tombstoneRow("a", T), false)).toEqual({ kind: "skip" }));
  it("A-7-12 missing content without tombstone", () => expect(mergePageDecision(page(), { ...tombstoneRow("a", T), deleted_at: null }, false)).toEqual({ kind: "skip" }));
  it("A-7-13 foreign tombstones", () => { for (const updatedAt of [T - 1, T + 1]) expect(mergePageDecision(page({ updatedAt }), tombstoneRow("a", T), true)).toEqual({ kind: "skip" }); });
  it("A-7-14 local only page", () => { const a = page({ id: "a" }), b = page({ id: "b" }); expect(localOnlyPages({ a, b }, new Set(["b"]), () => false)).toEqual([a]); });
  it("A-7-15 omit local trash", () => expect(localOnlyPages({ a: page({ id: "a", isDeleted: true }) }, new Set(), () => false)).toEqual([]));
  it("A-7-16 omit foreign pages", () => expect(localOnlyPages({ a: page({ id: "a" }) }, new Set(), () => true)).toEqual([]));
  it("A-7-17 all pages known", () => expect(localOnlyPages({ a: page({ id: "a" }) }, new Set(["a"]), () => false)).toEqual([]));
  it("A-7-18 merge local-only and server pages", () => {
    const local = { localOnly: page({ id: "localOnly", updatedAt: T }), shared: page({ id: "shared", updatedAt: T - 1000 }) };
    const rows = [liveRow("shared", T), liveRow("serverOnly", T)], applied: Record<string, unknown> = {};
    for (const row of rows) { const choice = mergePageDecision(local[row.id as keyof typeof local], row, false); if (choice.kind === "apply") applied[row.id] = choice.page; }
    expect(localOnlyPages(local, new Set(rows.map((r) => r.id)), () => false)).toEqual([local.localOnly]);
    expect(Object.keys(applied).sort()).toEqual(["serverOnly", "shared"]); expect(applied.serverOnly).not.toBeNull();
  });
});
describe("reminder merge", () => {
  it("A-7-20 identical reminder", () => { const local = [reminder()]; expect(mergeReminders(local, [reminderRow()], 1)).toEqual({ changed: false, merged: local }); });
  it("A-7-21 adopt reminder", () => expect(mergeReminders([], [reminderRow()], 0)).toMatchObject({ changed: true, merged: [{ text: "Ping" }] }));
  it("A-7-22 remove tombstone", () => expect(mergeReminders([reminder(), reminder("r2")], [reminderRow("r1", { deleted_at: new Date(T).toISOString() })], 2)).toEqual({ changed: true, merged: [reminder("r2")] }));
  it("A-7-23 unknown reminder tombstone", () => expect(mergeReminders([], [reminderRow("r1", { deleted_at: new Date(T).toISOString() })], 0).merged).toEqual([]));
  it("A-7-24 keep local and server reminder", () => expect(mergeReminders([reminder("localOnly")], [reminderRow("server")], 1).merged.map((r) => r.id)).toEqual(["localOnly", "server"]));
  it("A-7-25 adopt notified", () => expect(mergeReminders([reminder()], [reminderRow("r1", { notified: true })], 1)).toMatchObject({ changed: true, merged: [{ notified: true }] }));
  it("A-7-26 keep notified", () => expect(mergeReminders([reminder("r1", true)], [reminderRow()], 1)).toMatchObject({ changed: false, merged: [{ notified: true }] }));
  it("A-7-27 preserve reminder identity", () => { const local = reminder(); expect(mergeReminders([local], [reminderRow()], 1).merged[0]).toBe(local); });
  it("A-7-28 notified does not mutate local", () => { const local = reminder(); mergeReminders([local], [reminderRow("r1", { notified: true })], 1); expect(local.notified).toBe(false); });
  it("A-7-29 changed when server replaces reminders", () => expect(mergeReminders([], [], 2)).toEqual({ changed: true, merged: [] }));
  it("A-7-30 optional blockId", () => { expect(reminderFromRow(reminderRow("r1", { block_id: "b1" }))).toHaveProperty("blockId", "b1"); expect(reminderFromRow(reminderRow())).not.toHaveProperty("blockId"); });
  it("A-7-31 null pageId", () => expect(reminderFromRow(reminderRow("r1", { page_id: null })).pageId).toBe(""));
});
