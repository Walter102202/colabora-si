import { expect, it } from "vitest";
import { tramaSuggestions } from "@/lib/tramaSuggestions";

it.each(["en", "es"] as const)("prioritizes selection, decisions and context in %s", (lang) => {
  const result = tramaSuggestions({ kind: "text", selection: true, decisions: 2, lang });
  expect(result).toEqual(lang === "es" ? ["Explícame lo seleccionado", "¿Qué necesita mi decisión primero?", "Resume esta página"] : ["Explain the selection", "What needs me first?", "Summarize this page"]);
});
it.each(["home", "text", "database", "task"] as const)("provides a context suggestion for %s", (kind) => {
  const result = tramaSuggestions({ kind, selection: false, decisions: 0, lang: "en" });
  expect(result).toHaveLength(2);
  expect(result[1]).toBe("How is everything going?");
  expect(result[0]).toBe({ home: "What should I look at today?", text: "Summarize this page", database: "What is still open here?", task: "What is blocking this task?" }[kind]);
});
