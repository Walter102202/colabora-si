import { expect, it } from "vitest";
import { hitFromRemote, rankLocal, recentHits } from "@/lib/search";
import { b, db, page, prop, row, T } from "./fixtures";

it("SR-1 rankLocal scores title, body, comments and cells", () => {
  const cafe = page({ title: "Café plan", blocks: [b("paragraph", { html: "the plan" })] });
  const first = page({ title: "Plan A" });
  const comment = page({ comments: [{ id: "c", body: "plan b", authorId: "human", authorType: "human", createdAt: T }] });
  const pages = Object.fromEntries([cafe, first, comment].map((p) => [p.id, p]));
  const hits = rankLocal(pages, {}, "plan");
  expect(hits.map((h) => [h.id, h.score])).toEqual([[first.id, 15], [cafe.id, 13], [comment.id, 2]]);
  expect(hits[1]).toMatchObject({ kind: "page", pageId: cafe.id });
  expect(hits[1].snippet).not.toBe("");
  expect(hits.every((h) => h.id === h.pageId)).toBe(true);
});
it("SR-2 rankLocal marks rows and skips trash", () => {
  const base = page({ id: "d", database: db([prop({ id: "title" })], [row({ title: "Row plan" }, "r")]) });
  const r = page({ id: "r", parentId: base.id, title: "Row plan" });
  const trash = page({ id: "trash", title: "Plan trash", isDeleted: true });
  const hits = rankLocal({ d: base, r, trash }, {}, "plan");
  expect(hits.find((h) => h.id === "r")?.kind).toBe("row");
  expect(hits.some((h) => h.id === "trash")).toBe(false);
});
it("SR-3 recentHits returns the eight most recent pages with score 0", () => {
  const pages = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, page({ id: `p${i}`, updatedAt: T + i })]));
  const hits = recentHits(pages);
  expect(hits.map((h) => h.id)).toEqual(["p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2"]);
  expect(hits.every((h) => h.score === 0)).toBe(true);
});
it("SR-4 hitFromRemote validates and strips headline markup", () => {
  const hit = { kind: "page", id: "a", pageId: "a", title: "T", snippet: "a <b>x</b>", score: 0.5 };
  expect(hitFromRemote(hit)).toMatchObject({ ...hit, snippet: "a x" });
  expect(hitFromRemote(hit)?.blockId).toBeUndefined();
  expect(hitFromRemote({ ...hit, kind: "file" })).toBeNull();
  expect(hitFromRemote({})).toBeNull();
});
