import { expect, it } from "vitest";
import { createBlock, createDatabase, createPage, createProperty, createView, newId } from "@/lib/factories";

it("A-2-1 newId returns 12 nanoid characters", () => {
  expect(newId()).toMatch(/^[A-Za-z0-9_-]{12}$/);
});
it("A-2-2 new pages have matching timestamps", () => {
  const page = createPage();
  expect(page.createdAt).toBe(page.updatedAt);
});
it("A-2-3 new pages contain one empty paragraph", () => {
  expect(createPage().blocks).toEqual([expect.objectContaining({ type: "paragraph", html: "", indent: 0 })]);
});
it("A-2-4 block patches override defaults", () => {
  expect(createBlock("todo", { id: "todo", checked: true })).toEqual({ id: "todo", type: "todo", html: "", indent: 0, checked: true });
});
it("A-2-5 database has title, status, date and two views", () => {
  const database = createDatabase();
  expect(database.properties.map((p) => p.name)).toEqual(["Name", "Status", "Date"]);
  expect(database.views.map((v) => v.type)).toEqual(["table", "board"]);
  expect(createProperty({ name: "Owner" })).toMatchObject({ name: "Owner", type: "text" });
});
it("A-2-6 views use sorts and filters arrays", () => {
  for (const view of [createView(), ...createDatabase().views]) {
    expect(view.sorts).toEqual([]);
    expect(view.filters).toEqual([]);
    expect(view).not.toHaveProperty("sortBy");
    expect(view).not.toHaveProperty("filter");
  }
});
