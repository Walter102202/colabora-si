// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";
import AppNavigation from "@/components/AppNavigation";
import { runAgentAction } from "@/lib/agentActions";
import { useAgentTasks } from "@/lib/agentTasks";
import { mockCard } from "@/components/agents/card/mock";
import type { TaskCardData } from "@/lib/agentCard";
import * as api from "@/lib/agentClient";

function Location() { const location = useLocation(); return createElement("output", null, location.pathname + location.search); }
it.each(["done", "ready_for_review"] as const)("empty page/database actions open feedback for %s", async (state) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const rpc = vi.fn(async () => ({ data: {}, error: null }));
  const spy = vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc } as unknown as ReturnType<typeof api.getAgentClient>);
  const task = { ...(mockCard("1") as TaskCardData).task, state };
  useAgentTasks.setState({ workspaceId: null, tasks: { [task.id]: task } });
  try {
    act(() => root.render(createElement(MemoryRouter, null, createElement(AppNavigation), createElement(Location))));
    for (const mode of ["new", "continue"] as const) {
      await act(async () => runAgentAction({ id: "button", kind: "agentTask", mode, message: "  " }, { pageId: task.row_page_id }));
      expect(host.querySelector("output")?.textContent).toBe(`/p/${task.row_page_id}?task=${task.id}`);
      expect(rpc).not.toHaveBeenCalled();
    }
    await act(async () => runAgentAction({ id: "button", kind: "agentTask", mode: "continue", message: "Change the dates" }, { pageId: task.row_page_id }));
    expect(rpc).toHaveBeenCalledExactlyOnceWith("send_agent_message", expect.objectContaining({ p_body: "Change the dates", p_signal: "continue" }));
  } finally { act(() => root.unmount()); host.remove(); spy.mockRestore(); useAgentTasks.setState({ tasks: {} }); }
});
