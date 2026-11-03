import { expect, it } from "vitest";
import { buildSystemPrompt, buildTaskMessage } from "../../agent/prompt.mjs";

it("the task message carries the package as data", () => {
  const message = buildTaskMessage({ task_id: "t", run_id: "r", brief: {}, context_package: { lessons: [{ id: "l1", text: "Use DD/MM/YYYY", why: "Accepted for this project" }] } });
  expect(message).toContain("Use DD/MM/YYYY");
  expect(message).toContain("Accepted for this project");
});

it("uses the display identity without replacing the harness fallback", () => {
  expect(buildSystemPrompt({ harness: "codex-host", displayName: "Trama" })).toContain('You are "Trama"');
  expect(buildSystemPrompt({ harness: "codex-host" })).toContain('You are "codex-host"');
});

it("tells the agent to build under its task page, in one create_database call, and to read it back before delivering", () => {
  const prompt = buildSystemPrompt({ harness: "trama" });
  expect(prompt).toContain("never at the root");
  expect(prompt).toContain("Create a database complete in one create_database call");
  expect(prompt).toContain("read it back with query_database");
});

it("guides Trama to delegate each plan piece using the claimed agent roster", () => {
  expect(buildSystemPrompt({ harness: "trama" })).toContain("one subtask per piece with create_subtask");
});
