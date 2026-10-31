import { expect, it } from "vitest";
import { TRAMA_GREETING, tramaSuggestions } from "@/lib/tramaSuggestions";

it.each([false, true])("prioritizes selection and decisions (selection=%s)", (selection) => {
  const result = tramaSuggestions({ kind: "text", selection, decisions: 2 });
  expect(result).toEqual(selection
    ? ["Can you explain this selection?", "What needs me first?", "Can you summarize this page?"]
    : ["What needs me first?", "Can you summarize this page?", "How is everything going?"]);
  expect(TRAMA_GREETING).toBe("What are you up to?");
});
it.each(["home", "text", "database", "task"] as const)("always provides three unique English questions for %s", (kind) => {
  const english = new Set(["Can you explain this selection?", "What needs me first?", "What should I look at today?", "Can you summarize this page?", "What is still open here?", "What is blocking this task?", "How is everything going?"]);
  for (const selection of [false, true]) for (const decisions of [0, 2]) {
    const result = tramaSuggestions({ kind, selection, decisions });
    expect(result).toHaveLength(3);
    expect(new Set(result).size).toBe(3);
    expect(result.every((question) => english.has(question))).toBe(true);
  }
  expect(tramaSuggestions({ kind, selection: false, decisions: 0 })[0]).toBe({ home: "What should I look at today?", text: "Can you summarize this page?", database: "What is still open here?", task: "What is blocking this task?" }[kind]);
});
