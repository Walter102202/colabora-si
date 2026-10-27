import { describe, expect, it } from "vitest";
import corpus from "./corpus/agentInput.json";
import {
  ALLOWED_BLOCK_TYPES,
  COMPUTED_PROPERTY_TYPES,
  markdownToAgentBlocks,
  validateAgentCell,
  type AgentBlockInput,
} from "@/lib/agentInput";

type Case = { name: string; md: string; blocks: AgentBlockInput[] };

describe("markdownToAgentBlocks", () => {
  it.each((corpus as Case[]).map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(markdownToAgentBlocks(c.md)).toEqual(c.blocks);
  });

  it("only emits allowed block types", () => {
    const all = (corpus as Case[]).flatMap((c) => markdownToAgentBlocks(c.md));
    for (const block of all) expect(ALLOWED_BLOCK_TYPES).toContain(block.type);
  });
});

describe("validateAgentCell", () => {
  it.each(COMPUTED_PROPERTY_TYPES.map((t) => [t]))("rejects computed property %s", (type) => {
    expect(() => validateAgentCell(type, { text: "x" })).toThrow("computed_property");
  });

  it("accepts values that match the property type", () => {
    expect(validateAgentCell("select", { select: "A" })).toEqual({ select: "A" });
    expect(validateAgentCell("number", { number: 3.5 })).toEqual({ number: 3.5 });
    expect(validateAgentCell("date", { date: "2026-01-02", end: "2026-01-03T10:00:00Z" })).toEqual({ date: "2026-01-02", end: "2026-01-03T10:00:00Z" });
    expect(validateAgentCell("multiSelect", { multiSelect: ["a", "b"] })).toEqual({ multiSelect: ["a", "b"] });
    expect(validateAgentCell("url", { url: "https://a.test" })).toEqual({ url: "https://a.test" });
  });

  it.each([
    ["select", { select: 1 }],
    ["select", "A"],
    ["number", { number: Number.NaN }],
    ["checkbox", { checkbox: "yes" }],
    ["date", { date: "tomorrow" }],
    ["url", { url: "javascript:alert(1)" }],
    ["email", { email: "nobody" }],
    ["text", { text: "a", extra: true }],
    ["relation", { relation: [1] }],
  ] as const)("rejects a %s value of the wrong shape", (type, value) => {
    expect(() => validateAgentCell(type, value)).toThrow("invalid_input");
  });
});
