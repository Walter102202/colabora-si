// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { InboxBell } from "@/components/agents/InboxBell";
import { useAuthStore } from "@/lib/auth";
import { useAgentNotifications } from "@/lib/agentNotifications";
import { useStore } from "@/lib/store";

const signIn = (id: string | null) => useAuthStore.setState({ user: id ? ({ id } as User) : null, loading: false });

let container: HTMLDivElement;
let root: Root;
let subscribe: Mock<(userId: string) => () => void>;
let release: Mock<() => void>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  release = vi.fn<() => void>();
  subscribe = vi.fn<(userId: string) => () => void>(() => release);
  useStore.setState({ syncWorkspaceId: "w1", syncUserId: "u-me" });
  useAgentNotifications.setState({ notifications: [], subscribe });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const mount = () => act(() => root.render(createElement(MemoryRouter, null, createElement(InboxBell))));

describe("InboxBell", () => {
  it("shows for the signed-in person and hides once they sign out, though the sync id stays persisted", () => {
    signIn("u-me");
    mount();
    expect(subscribe).toHaveBeenCalledWith("u-me");
    expect(container.querySelector('button[aria-label="Inbox"]')).not.toBeNull();
    act(() => signIn(null));
    expect(container.innerHTML).toBe("");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("stays hidden for another account until sync binds the workspace to it", () => {
    signIn("u-other");
    mount();
    expect(container.innerHTML).toBe("");
    expect(subscribe).not.toHaveBeenCalled();
  });
});
