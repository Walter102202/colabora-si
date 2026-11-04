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

it("gives Autonomous Leads a complete closure route with precise person boundaries", () => {
  const prompt = buildSystemPrompt({ harness: "trama", reviewerAgentId: "reviewer" });
  for (const line of ["At Autonomous you finish the job", "Never ask whether you may close", "only for a criterion a person wrote", "a screenshot is evidence for a screen", "only for a decision the brief leaves open"]) expect(prompt).toContain(line);
  expect(prompt).not.toMatch(/Never mark a task.*done|otherwise leave it to a person/);
  expect(prompt).toContain('marks check: human only for something the person said');
});
