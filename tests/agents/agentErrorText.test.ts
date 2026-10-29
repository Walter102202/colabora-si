import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentErrorMessage } from "@/lib/agentClient";
import { closeTask, handOver } from "@/lib/agentActions";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/agentClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentClient")>()),
  getAgentClient: () => ({ rpc }),
}));

beforeEach(() => rpc.mockReset());

describe("texts for the errors of a person's agent actions", () => {
  it("invalid_state is generic, and a locked page and a stop request have their own text", () => {
    expect(agentErrorMessage({ message: "invalid_state" })).toBe("The task changed state. Refresh and try again.");
    expect(agentErrorMessage({ message: "page_locked" })).toBe("The page is locked. Unlock it to revert.");
    expect(agentErrorMessage({ message: "stop_requested" })).toBe("A stop was requested for this run. Wait for the agent to stop.");
    // The row panel reloads the diff after a failed revert, so these texts do not ask to refresh it.
    expect(agentErrorMessage({ message: "revert_conflict" })).toBe("Some of these changes were edited after the run, so nothing was reverted. Check the list and try again.");
    expect(agentErrorMessage({ message: "item_not_found" })).toBe("That change is no longer in the list.");
  });

  it("a handover the task's state does not allow keeps its own text; closing the task gets the generic one", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "invalid_state", code: "PT422" } });
    await expect(handOver("t1", "agent-2", "")).rejects.toThrow("The task cannot be handed over in its current state.");
    await expect(closeTask("t1", "accepted")).rejects.toThrow("The task changed state. Refresh and try again.");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["release_for_handover", "close_task"]);
  });
});
