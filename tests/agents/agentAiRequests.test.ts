// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { requestMeetingSummary } from "@/lib/agentAiRequests";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), flush: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabase: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/sync", () => ({ flush: mocks.flush, useSyncStatus: { getState: () => ({ status: "synced" }) } }));
it("flushes the page before requesting its meeting summary", async () => {
  mocks.rpc.mockResolvedValue({ data: { task_id: "t" }, error: null });
  expect(await requestMeetingSummary("p", "m", "es")).toEqual({ taskId: "t" });
  expect(mocks.rpc).toHaveBeenCalledWith("request_meeting_summary", { p_page_id: "p", p_block_id: "m", p_lang: "es" });
  expect(mocks.flush.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
});
