// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CommentThread } from "@/components/BlockCommentsPopover";
import { useStore } from "@/lib/store";
import { useDirectory } from "@/lib/directory";
import { page } from "../clone/fixtures";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useDirectory.setState({ workspaceId: "w", entries: [] });
  useStore.setState({ syncWorkspaceId: "w", members: [], agents: [], pages: { p: page({ id: "p", comments: [
    { id: "reply", authorId: "agent-user", authorType: "agent", author: "agent+internal@agents.invalid", body: "Answer", createdAt: Date.now() },
    { id: "person", authorId: "person", authorType: "human", author: "Original person name", body: "Question", createdAt: Date.now() },
  ] }) } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it.each(["directory", "legacy cache"])("uses the agent name from the %s instead of its internal email", (source) => {
  if (source === "directory") useDirectory.setState({ entries: [{ workspace_id: "w", user_id: "agent-user", display_name: "Colabora", is_agent: true }] });
  else useStore.setState({ agents: [{ id: "agent-user", type: "agent", name: "Colabora" }] });
  act(() => root.render(createElement(CommentThread, { pageId: "p" })));
  expect(container.textContent).toContain("Colabora");
  expect(container.textContent).not.toContain("agent+internal@agents.invalid");
});
it("uses an Agent fallback when its directory entry is unavailable and preserves human attribution", () => {
  act(() => root.render(createElement(CommentThread, { pageId: "p" })));
  expect(container.textContent).not.toContain("agent+internal@agents.invalid");
  expect(container.textContent).toContain("Agent");
  expect(container.textContent).toContain("Original person name");
});
