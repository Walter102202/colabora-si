import { expect, it } from "vitest";
import { pageDataSizes } from "@/lib/metrics";
import { b, page } from "./fixtures";

it("MT-1 pageDataSizes counts bytes and the 95th percentile", () => {
  const pages = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i + 1}`, page({ id: `p${i + 1}`, title: `Café ${i + 1}`, blocks: [b("paragraph", { html: "x".repeat(100 * (i + 1)) })] })]));
  const bytes = (id: string) => new TextEncoder().encode(JSON.stringify(pages[id])).byteLength;
  const sizes = pageDataSizes(pages);
  expect(sizes.count).toBe(20);
  expect(sizes.totalBytes).toBe(Object.keys(pages).reduce((sum, id) => sum + bytes(id), 0));
  expect(sizes.p95Bytes).toBeGreaterThanOrEqual(bytes("p19"));
  expect(sizes.p95Bytes).toBeLessThanOrEqual(bytes("p20"));
  expect(sizes.largest[0].id).toBe("p20");
  expect(sizes.largest).toHaveLength(5);
});
it("MT-2 empty workspace", () => {
  expect(pageDataSizes({})).toEqual({ count: 0, totalBytes: 0, p95Bytes: 0, largest: [] });
});
