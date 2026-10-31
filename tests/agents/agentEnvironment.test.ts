// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EnvironmentList } from "@/components/agents/settings/EnvironmentList";

const state = vi.hoisted(() => ({
  rpc: vi.fn(),
  rows: [{ task_id: "release-task", kind: "stack", value: "local-test", status: "releasing", task: { title: "Stopped task", row_page_id: "row" } }],
}));
vi.mock("@/lib/agentClient", async (original) => ({
  ...(await original<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => ({ rpc: state.rpc, from: () => ({ select: () => ({ eq: () => ({ neq: () => ({ order: async () => ({ data: state.rows, error: null }) }) }) }) }) }),
}));

it("confirms the exact task's shutdown, preserves resources after rejection, and refreshes after success", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const confirm = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm stopped");
  try {
    state.rpc.mockResolvedValueOnce({ data: null, error: { message: "forbidden" } });
    await act(async () => root.render(createElement(EnvironmentList, { workspaceId: "workspace" })));
    expect(confirm()).toBeDefined();
    await act(async () => confirm()!.click());
    expect(state.rpc).toHaveBeenCalledExactlyOnceWith("release_environment", { p_task_id: "release-task" });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("local-test");
    state.rpc.mockImplementationOnce(async () => { state.rows = []; return { data: { released: 1 }, error: null }; });
    await act(async () => confirm()!.click());
    expect(container.textContent).toContain("No environments are held.");
    expect(confirm()).toBeUndefined();
  } finally { act(() => root.unmount()); container.remove(); }
});
