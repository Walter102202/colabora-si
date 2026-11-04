import { expect, it } from "vitest";
import { estimateTokens, trimMessages } from "../../agent/context.mjs";
const sys = { role: "system", content: "x".repeat(400) };
const task = { role: "user", content: "y".repeat(400) };
function turns(n: number, size: number) {
  return Array.from({ length: n }, (_, i) => [
    { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_page", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: "z".repeat(size) },
  ]).flat();
}

it("CT-1 estimateTokens counts a quarter of the serialized characters", () => {
  expect(estimateTokens([{ role: "user", content: "abcd".repeat(100) }])).toBe(Math.ceil(JSON.stringify([{ role: "user", content: "abcd".repeat(100) }]).length / 4));
});
it("CT-2 leaves messages alone under the budget", () => {
  const messages = [sys, task, ...turns(3, 1000)];
  const before = structuredClone(messages);
  expect(trimMessages(messages, { budgetTokens: 100_000, keepTurns: 2 })).toEqual({ elided: 0, tokens: estimateTokens(before) });
  expect(messages).toEqual(before);
});
it("CT-3 over the budget elides the tool results older than keepTurns and nothing else", () => {
  const messages = [sys, task, ...turns(10, 4000)];               // ≈ 10.3k tokens
  const result = trimMessages(messages, { budgetTokens: 5_000, keepTurns: 2 });
  expect(result.elided).toBe(8);
  expect(result.tokens).toBeLessThanOrEqual(5_000);
  expect(messages[0]).toEqual(sys); expect(messages[1]).toEqual(task);
  const tools = messages.filter((m) => m.role === "tool");
  expect(tools.slice(0, 8).every((m) => JSON.parse(m.content!).elided === true && "tool_call_id" in m && m.tool_call_id)).toBe(true);
  expect(tools.slice(8).every((m) => m.content === "z".repeat(4000))).toBe(true);
  expect(messages.filter((m) => m.role === "assistant")).toHaveLength(10);
});
it("CT-4 is idempotent: a second pass changes nothing", () => {
  const messages = [sys, task, ...turns(10, 4000)];
  trimMessages(messages, { budgetTokens: 5_000, keepTurns: 2 });
  const after = structuredClone(messages);
  expect(trimMessages(messages, { budgetTokens: 5_000, keepTurns: 2 }).elided).toBe(0);
  expect(messages).toEqual(after);
});

it("CT-6 preserves recent turns and human updates even when they exceed the budget", () => {
  const messages = [sys, task, ...turns(2, 4000), { role: "user", content: "Human update".repeat(400) }];
  const before = structuredClone(messages);
  expect(trimMessages(messages, { budgetTokens: 100, keepTurns: 6 }).elided).toBe(0);
  expect(messages).toEqual(before);
});
