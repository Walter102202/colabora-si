// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isShell, joinPage, overlayMeta, pageReferences, shellFromMeta, shellOf, splitPage } from "@/lib/pageShell";
import { touch } from "@/lib/pageMutations";
import { findBacklinks } from "@/lib/pageStats";
import { useStore } from "@/lib/store";
import { b, column, db, page, prop, row, T } from "./fixtures";

const savedRow = row({ title: "Archived", attachment: "file-1" }, "archived");
const database = { ...db([prop({ type: "relation", id: "relation" })], [row({ relation: ["related"] })]), locked: true,
  rowTemplates: [{ id: "template", name: "Template", cells: { relation: ["related"] }, blocks: [b()] }] };
const fixtures = [
  page(), page({ revision: 0 }), page({ revision: 7, database }),
  page({ blocks: [b("columns", { columns: [column([b()])] })] }),
  page({ comments: [{ id: "comment", body: "Comment", authorId: "person", authorType: "human", createdAt: T }] }),
  page({ versions: [{ id: "version", createdAt: T, title: "Earlier", blocks: [b()], database }] }),
  page({ rowOrigin: { databasePageId: "parent", row: savedRow, index: 2 } }),
];

describe("page metadata and bodies", () => {
  it.each(fixtures)("round-trips fixture $id without losing its content", (original) => {
    const { meta, body } = splitPage(original);
    expect(joinPage(meta, body)).toEqual(original);
  });

  it("preserves unknown page fields", () => {
    const original = { ...page(), futureSetting: { enabled: true } };
    const { meta, body } = splitPage(original);
    expect(joinPage(meta, body)).toEqual(original);
  });

  it("marks empty shells through copies, touch and the store's cleanPage path", () => {
    const shell = shellOf(page({ blocks: [b()], database }));
    expect(isShell(shell)).toBe(true);
    expect(isShell({ ...shell, title: "Changed" })).toBe(true);
    expect(isShell(touch(shell))).toBe(true);
    useStore.getState().applyRemotePages({ pages: { [shell.id]: shell } });
    expect(isShell(useStore.getState().pages[shell.id])).toBe(true);
    expect(shell.blocks).toEqual([]);
    expect(shell.database?.rows).toEqual([]);
    expect(isShell(null)).toBe(false);
    expect(isShell(undefined)).toBe(false);
  });

  it("does not serialize its marker and rejects splitting a shell", () => {
    const shell = shellOf(page());
    expect(isShell(JSON.parse(JSON.stringify(shell)))).toBe(false);
    expect(() => splitPage(shell)).toThrow("shell_has_no_body");
  });

  it("retains the database header and archived row metadata", () => {
    const original = page({ database, rowOrigin: { databasePageId: "parent", row: savedRow, index: 2 } });
    const shell = shellFromMeta(splitPage(original).meta);
    expect(shell.database).toEqual({ id: database.id, properties: database.properties, views: database.views, locked: true, rows: [] });
    expect(shell.rowOrigin).toEqual(original.rowOrigin);
  });

  it("overlays newer metadata while retaining full content and its revision", () => {
    const full = page({ blocks: [b()], database, revision: 3, comments: fixtures[4].comments, versions: fixtures[5].versions });
    const shell = shellOf({ ...full, title: "New title", isDeleted: true, revision: 4, database: { ...database, locked: false } });
    const result = overlayMeta(full, shell);
    expect(result).toEqual({ ...full, title: "New title", isDeleted: true, database: { ...database, locked: false } });
    expect(isShell(result)).toBe(false);
    expect(result.blocks).toBe(full.blocks);
    expect(result.database?.rows).toBe(full.database?.rows);
  });

  it("removes a restored row's obsolete rowOrigin", () => {
    const full = fixtures[6];
    const shell = shellOf(page({ id: full.id }));
    expect(overlayMeta(full, shell).rowOrigin).toBeUndefined();
  });

  it("indexes the same page, database, HTML, column and relation references as backlinks", () => {
    const ids = ["page-target", "database-target", "html-target", "column-target", "related"];
    const source = page({ id: "source", database, blocks: [
      b("page", { pageId: ids[0] }), b("database", { pageId: ids[1] }),
      b("paragraph", { html: '<a href="/p/html-target?task=one">Link</a>' }),
      b("columns", { columns: [column([b("page", { pageId: ids[3] })])] }),
      b("page", { pageId: "source" }), b("page", { pageId: ids[0] }),
    ] });
    const pages = Object.fromEntries([source, ...ids.map((id) => page({ id }))].map((p) => [p.id, p]));
    expect(pageReferences(source).sort()).toEqual(ids.sort());
    for (const id of ids) expect(findBacklinks(pages, id).map((p) => p.id)).toEqual([source.id]);
    expect(pageReferences(source)).not.toContain(source.id);
  });
});
