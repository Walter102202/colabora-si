import { expect, it } from "vitest";
import { createBlock } from "@/lib/factories";
import { unlinkedSubpages } from "@/lib/subpages";
import { db, page } from "./fixtures";

const parent = (blocks = [createBlock("paragraph")]) => page({ id: "parent", title: "Home", blocks });
const child = (id: string, patch = {}) => page({ id, title: id, parentId: "parent", createdAt: 1, ...patch });
const ids = (home: ReturnType<typeof parent>, ...children: ReturnType<typeof child>[]) =>
  unlinkedSubpages(home, Object.fromEntries([home, ...children].map((p) => [p.id, p]))).map((p) => p.id);

it("shows a page moved or added inside, which the body does not link", () => {
  expect(ids(parent(), child("moved"))).toEqual(["moved"]);
});
it("does not repeat a page the body already links", () => {
  expect(ids(parent([createBlock("page", { pageId: "linked" })]), child("linked"), child("moved"))).toEqual(["moved"]);
});
it("finds links and inline databases inside columns", () => {
  const columns = createBlock("columns", { columns: [{ id: "c", width: 50, blocks: [createBlock("database", { pageId: "inline" })] }] });
  expect(ids(parent([columns]), child("inline"))).toEqual([]);
});
it("leaves out pages in the trash", () => {
  expect(ids(parent(), child("gone", { isDeleted: true }))).toEqual([]);
});
it("leaves out the rows of a database, which its table already shows", () => {
  expect(ids({ ...parent(), database: db([]) }, child("row"))).toEqual([]);
});
