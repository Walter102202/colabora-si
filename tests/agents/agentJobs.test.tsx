// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eligibleJobAgents, jobReadyPanel, type JobAgent } from "@/lib/agentJobs";
import { JobAgentPicker } from "@/components/agents/panel/JobAgentPicker";
import { JobReadyPanel } from "@/components/agents/panel/JobReadyPanel";

const lead: JobAgent = { id: "lead", name: "My Claude Code", logo: null, role: "lead" };
const worker: JobAgent = { id: "worker", name: "Codex", logo: null, role: "worker" };
const other: JobAgent = { id: "other", name: "Cursor", logo: null, role: "lead" };
const input = { title: "Market research", lead, workers: [worker], subtaskCount: 0, hasPlan: false };

describe("job preparation", () => {
  it("offers only verified, enabled external agents that have not been revoked", () => {
    const agent = { id: "a", name: "Codex", is_platform: false, status: "enabled" as const, revoked_at: null, role: "worker" as const };
    const connection = { agent_id: "a", verified_at: "2026-11-01" };
    expect(eligibleJobAgents([agent], [connection])).toEqual([{ id: "a", name: "Codex", logo: "/brand/agents/codex.svg", role: "worker" }]);
    expect(eligibleJobAgents([agent], [{ ...connection, verified_at: null }])).toEqual([]);
    for (const patch of [{ is_platform: true }, { status: "paused" as const }, { status: "disabled" as const }, { revoked_at: "2026-11-01" }]) {
      expect(eligibleJobAgents([{ ...agent, ...patch }], [connection])).toEqual([]);
    }
  });
  it("uses actual names, singular/plural crew text and preserves the person's subtasks", () => {
    const solo = jobReadyPanel({ ...input, workers: [] });
    expect(solo.lines.map((line) => line.text)).toEqual(["Work on Market research as Lead"]);
    expect(solo.readyNote).toBe("Nothing starts until My Claude Code arrives. It writes the subtasks and does them itself.");
    const one = jobReadyPanel(input);
    expect(one.lines.map((line) => line.text)).toEqual(["Work on Market research as Lead, with Codex as worker", "Work on Market research as worker"]);
    expect(one.waitingText).toBe("Waiting for My Claude Code. This page updates when it arrives.");
    const many = jobReadyPanel({ ...input, workers: [worker, other, worker, lead], subtaskCount: 2, hasPlan: true });
    expect(many.lines[0].text).toBe("Work on Market research as Lead, with Codex and Cursor as workers");
    expect(many.lines).toHaveLength(3);
    expect(many.readyNote).toBe("Nothing starts until My Claude Code arrives. It keeps your subtasks and writes the rest.");
    expect(many.planText).toBe("The plan is on this job’s page.");
  });
});

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("limits Lead choices and explains missing access without offering a forbidden selection", () => {
  const onChoose = vi.fn();
  const props = { agents: [lead, worker, other], selectedIds: [lead.id], onChoose, onClose: vi.fn(), connectHref: "/connect", agentsHref: "/agents" };
  act(() => root.render(<JobAgentPicker {...props} kind="lead" blockedAgentIds={[other.id]} />));
  expect(container.textContent).toContain("Lead for this job");
  expect(container.textContent).not.toContain("Codex");
  expect(container.textContent).toContain("Ask the workspace owner to give Cursor access.");
  const choice = container.querySelector('[aria-pressed="true"]') as HTMLButtonElement;
  act(() => choice.click()); expect(onChoose).toHaveBeenCalledWith(lead.id);
  act(() => root.render(<JobAgentPicker {...props} kind="lead" agents={[worker]} />));
  expect(container.textContent).toContain("No connected agents have the Lead role.");
  expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
});

it("allows either role as Worker, excludes the Lead and locks already assigned Workers after starting", () => {
  const onChoose = vi.fn();
  act(() => root.render(<JobAgentPicker kind="workers" agents={[lead, worker, other]} leadId={lead.id} selectedIds={[worker.id]} lockedIds={[worker.id]} onChoose={onChoose} onClose={() => {}} connectHref="/connect" agentsHref="/agents" />));
  expect(container.textContent).not.toContain(lead.name);
  const choices = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
  expect(choices).toHaveLength(2); expect(choices[0].disabled).toBe(true);
  act(() => choices[1].click()); expect(onChoose).toHaveBeenCalledWith(other.id);
});

it("copies the requested line, then shows waiting only when the Lead's line was copied", () => {
  const data = jobReadyPanel(input), onCopy = vi.fn();
  const props = { data, onCopy, onOpenPage: vi.fn() };
  act(() => root.render(<JobReadyPanel {...props} copiedAgentIds={[worker.id]} />));
  expect(container.textContent).toContain("Ready when you are");
  expect(container.textContent).not.toContain(data.waitingText);
  act(() => (container.querySelector(`button[aria-label="Copy what to say to ${lead.name}"]`) as HTMLButtonElement).click());
  expect(onCopy).toHaveBeenCalledWith(data.lines[0]);
  act(() => root.render(<JobReadyPanel {...props} copiedAgentIds={[lead.id]} />));
  expect(container.querySelector('[role="status"]')?.textContent).toBe(data.waitingText);
});
