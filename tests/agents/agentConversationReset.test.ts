import { afterEach, expect, it, vi } from "vitest";
import { currentThread, useAgentConversation, type PersonMessage } from "@/lib/agentConversation";
import * as api from "@/lib/agentClient";

const message = (seq: number, extra: Partial<PersonMessage> = {}): PersonMessage => ({ id: String(seq), seq, workspace_id: "w", direction: "in", channel: "surface", kind: "text", body: String(seq), forwarded: false, outcome: null, created_at: "", ...extra });
const cut = (seq: number, from_seq?: number) => message(seq, { kind: "system", direction: "out", outcome: { kind: "conversation_reset", from_seq } });
afterEach(() => vi.restoreAllMocks());

it("returns the original thread without a cut", () => {
  const messages = [message(1)];
  expect(currentThread(messages)).toBe(messages);
});
it("keeps only messages after the cut", () => {
  expect(currentThread([message(1), cut(2), message(3)])).toEqual([message(3)]);
});
it("keeps the frozen start after pending messages are answered", () => {
  expect(currentThread([message(1), message(2), cut(3, 2), message(4)])).toEqual([message(2), message(4)]);
});
it("uses the latest cut and hides every cut", () => {
  expect(currentThread([message(1), cut(2), message(3), cut(4, 3), message(5)])).toEqual([message(3), message(5)]);
  expect(currentThread([cut(1), cut(2, 1)])).toEqual([]);
});

it.each(["success", "rpc error", "refresh error", "switched"])("reset action handles %s", async (outcome) => {
  let finish!: (value: { error: { message: string } | null }) => void;
  const rpc = vi.fn(() => new Promise<{ error: { message: string } | null }>((resolve) => { finish = resolve; }));
  const query = { select: () => query, eq: () => query, order: () => query, limit: vi.fn(async () => ({ data: [cut(2)], error: outcome === "refresh error" ? new Error("offline") : null })) };
  vi.spyOn(api, "getAgentClient").mockReturnValue({ rpc, from: () => query } as unknown as ReturnType<typeof api.getAgentClient>);
  const release = useAgentConversation.getState().subscribe("w", "alice");
  await Promise.resolve();
  useAgentConversation.setState({ messages: [message(1)], failed: { clientId: "draft", body: "retry", context: {} } });
  const resetting = useAgentConversation.getState().newConversation();
  if (outcome === "switched") release();
  finish({ error: outcome === "rpc error" ? { message: "offline" } : null });
  expect(await resetting).toBe(outcome === "success");
  expect(rpc).toHaveBeenCalledExactlyOnceWith("start_new_conversation", { p_workspace_id: "w" });
  if (outcome === "success") {
    expect(useAgentConversation.getState().failed).toEqual({ clientId: "draft", body: "retry", context: {} });
    expect(currentThread(useAgentConversation.getState().messages)).toEqual([]);
  }
  if (outcome === "switched") expect(useAgentConversation.getState().messages).toEqual([]);
  if (outcome === "refresh error") expect(useAgentConversation.getState().failed?.body).toBe("retry");
  release();
});
