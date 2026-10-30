import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { VerificationCard } from "@/components/agents/panel/VerificationCard";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import { CI_LABEL, type CiState } from "@/lib/agentCi";

const data = mockCard("1") as TaskCardData;
const brief = { ...data.brief!, done_when: [{ id: "ci", text: "Build passes", check: "ci" as const, command: "check" }] };
it.each(Object.keys(CI_LABEL) as CiState[])("shows the CI state %s with and without a review", (state) => {
  for (const review of [null, data.review]) {
    const html = renderToStaticMarkup(createElement(VerificationCard, { brief, review,
      ciChecks: [{ criterion_id: "ci", check: "check", state, url: "https://github.com/acme/app/actions/runs/1" }] }));
    expect(html).toContain(CI_LABEL[state]);
    expect(html).toContain(state === "passed" ? "✓" : state === "failed" ? "✗" : "–");
    expect(html).toContain('href="https://github.com/acme/app/actions/runs/1"');
  }
});
it("never links an unsafe CI URL or treats missing evidence as passing", () => {
  const html = renderToStaticMarkup(createElement(VerificationCard, { brief, review: null,
    ciChecks: [{ criterion_id: "ci", check: "check", state: "failed", url: "javascript:alert(1)" }] }));
  expect(html).not.toContain("href="); expect(html).toContain("CI failed");
  expect(renderToStaticMarkup(createElement(VerificationCard, { brief, review: null }))).toContain("Waiting for CI");
});
