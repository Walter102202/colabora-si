// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscrepancyCard } from "@/components/agents/panel/DiscrepancyCard";
import { openDiscrepancies, parseSourceInput, sourcesOfPage, type DiscrepancyRow, type PageSourceRow } from "@/lib/agentSources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); });

const discrepancy: DiscrepancyRow = { id: "d1", workspace_id: "w", page_id: "p", source_ids: ["s1"], summary: "Prices differ", status: "open", created_at: "2026-10-30T10:00:00Z",
  items: [{ source_id: "s1", source_says: "12", page_says: "10" }] };

function render(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  act(() => createRoot(host).render(element));
  return host;
}
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLButtonElement;

describe("DiscrepancyCard", () => {
  it("shows both sides and sends the person's choice", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    const host = render(createElement(DiscrepancyCard, { discrepancy, onResolve }));
    expect(host.textContent).toContain("The source says “12”. The page says “10”.");
    await act(async () => { button(host, "Keep it as it is").click(); });
    expect(onResolve).toHaveBeenCalledWith("keep", "");
  });
});


describe("selectors", () => {
  it("pick the sources of a page and the open differences", () => {
    const source = { id: "s", page_id: "p" } as PageSourceRow;
    expect(sourcesOfPage({ s: source, o: { ...source, id: "o", page_id: "x" } }, "p")).toEqual([source]);
    expect(openDiscrepancies({ d1: discrepancy, d2: { ...discrepancy, id: "d2", status: "resolved" } })).toEqual([discrepancy]);
  });
});

describe("parseSourceInput", () => {
  const origin = "https://app.example";
  it("reads a page of this app", () => expect(parseSourceInput(" https://app.example/p/abc?task=1 ", origin)).toEqual({ page_id: "abc" }));
  it("keeps an outside link as a URL", () => expect(parseSourceInput("https://other.example/p/abc", origin)).toEqual({ url: "https://other.example/p/abc" }));
  it("refuses anything else", () => {
    expect(parseSourceInput("javascript:alert(1)", origin)).toBeNull();
    expect(parseSourceInput("not a link", origin)).toBeNull();
  });
});
