// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import { useAuthStore } from "@/lib/auth";
import { TelegramConnection } from "@/components/agents/settings/TelegramConnection";
import { telegramLink, startTelegramLink, disconnectTelegram } from "@/lib/agentChannels";
vi.mock("@/lib/agentChannels", () => ({ telegramLink: vi.fn(), startTelegramLink: vi.fn(), disconnectTelegram: vi.fn() }));
it("connects through a one-use link, refreshes after Telegram and disconnects", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useAuthStore.setState({ user: { id: "person" } as User });
  vi.mocked(telegramLink).mockResolvedValue(false);
  vi.mocked(startTelegramLink).mockResolvedValue("https://t.me/test_bot?start=example");
  vi.mocked(disconnectTelegram).mockResolvedValue();
  const host = document.createElement("div"), root = createRoot(host); document.body.append(host);
  try {
    await act(async () => root.render(<TelegramConnection workspaceId="ws" />));
    await act(async () => host.querySelector("button")!.click());
    expect(startTelegramLink).toHaveBeenCalledWith("ws");
    expect(host.querySelector("a")?.href).toBe("https://t.me/test_bot?start=example");
    vi.mocked(telegramLink).mockResolvedValue(true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("button")?.textContent).toBe("Disconnect");
    await act(async () => host.querySelector("button")!.click());
    expect(disconnectTelegram).toHaveBeenCalledWith("ws");
    expect(host.querySelector("button")?.textContent).toBe("Connect Telegram");
  } finally { act(() => root.unmount()); host.remove(); }
});
