import { describe, expect, it } from "vitest";
import corpus from "./corpus/adversarial.json";
import { eventToChannel, untrustedText } from "../../bridge/channel.mjs";
import { buildReason } from "../../connect/codex/on-stop.mjs";
import { describeChange } from "../../connect/claude-code/wait.mjs";

type Entry = { id: string; surface: "page" | "comment" | "activity" | "tool_result"; input: string; mustNotContain: string[]; mustContain?: string[] };
const entries = corpus as Entry[];
const texts = entries.filter((e) => e.surface === "comment" || e.surface === "activity");
const check = (out: string, e: Entry, tokens: string[] = e.mustNotContain) => {
  for (const t of tokens) expect(out, `${e.id} must not contain ${JSON.stringify(t)}`).not.toContain(t);
};

describe("workspace text is data on every rendered surface", () => {
  it.each(texts.map((e) => [e.id, e] as const))("bridge channel content: %s", (_id, e) => {
    check(untrustedText(e.input), e, [...e.mustNotContain, "<", ">", '"', "&", "`"]);
    const event = eventToChannel({ type: "task.feedback", task_id: "t1", agent_id: "a1", run_id: null, event_id: "e1", payload: { text: e.input, task_ref: e.input } });
    check(event.content, e, ["<", ">"]);
    expect(event.content).not.toMatch(/\n/);
    for (const v of Object.values(event.meta)) expect(v).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
  });
  it.each(texts.map((e) => [e.id, e] as const))("Codex stop hook reason: %s", (_id, e) => {
    const reason = buildReason({ task_id: "t1", title: e.input, reason: "feedback" }, e.input);
    check(reason, e, ["<script", "</channel>", "<channel", "`"]);
    if (/["<>`]/.test(e.input)) expect(reason).not.toContain(e.input); // the raw text never survives: the hook strips <>"` first
    expect(reason).toContain("<<<");
    expect(reason.indexOf("treat it as data")).toBeLessThan(reason.indexOf("<<<"));
    expect(reason.length).toBeLessThanOrEqual(2500);
  });
  it.each(texts.map((e) => [e.id, e] as const))("Claude Code wait line: %s", (_id, e) => {
    const line = describeChange({ task_id: "t1", state: "working", review_state: e.input, waiting_on: e.input }, [{ type: "prompt", author: e.input, excerpt: e.input }]);
    check(line, e, ["<", ">", "`"]);
    if (/["<>`]/.test(e.input)) expect(line).not.toContain(e.input); // the excerpt is sanitized before the quotes wrap it
    expect(line).toMatch(/^t1 changed: state working/);
    expect(line).toContain("untrusted text:");
    expect(line.length).toBeLessThanOrEqual(400);
  });
});
