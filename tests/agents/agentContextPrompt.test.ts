import { expect, it } from "vitest";
import { buildTaskMessage } from "../../agent/prompt.mjs";

it("the task message carries the package as data", () => {
  const message = buildTaskMessage({ task_id: "t", run_id: "r", brief: {}, context_package: { lessons: [{ id: "l1", text: "Use DD/MM/YYYY", why: "Accepted for this project" }] } });
  expect(message).toContain("Use DD/MM/YYYY");
  expect(message).toContain("Accepted for this project");
});
