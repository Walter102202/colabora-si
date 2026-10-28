import { describe, expect, it } from "vitest";
import { pageUrl, peekUrl, pubUrl, searchUrl, settingsUrl, sharedUrl, taskUrl, withQuery } from "@/lib/routes";

describe("SPA deep links", () => {
  it("encodes identifiers without creating additional path or query segments", () => {
    expect(pageUrl("a/b ?")).toBe("/p/a%2Fb%20%3F");
    expect(sharedUrl("a/b")).toBe("/shared/a%2Fb");
    expect(pubUrl("a/b")).toBe("/pub/a%2Fb");
    expect(taskUrl("row", "task&other")).toBe("/p/row?task=task%26other");
  });
  it("opens settings, search and previews while preserving the page and task", () => {
    const task = taskUrl("row", "task");
    expect(settingsUrl("agents", task)).toBe("/p/row?task=task&settings=agents");
    expect(searchUrl("one & two", task)).toBe("/p/row?task=task&search=one+%26+two");
    expect(peekUrl("other", task)).toBe("/p/row?task=task&peek=other");
    expect(peekUrl(null, peekUrl("other", task))).toBe(task);
    expect(withQuery(task + "#block", { task: null })).toBe("/p/row#block");
  });
});
