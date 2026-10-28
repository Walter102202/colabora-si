"use client";
import Shell from "@/components/Shell";
import { McpPatPage } from "@/components/agents/McpPatPage";

export default function McpPatRoute() {
  return <Shell><div className="h-full overflow-y-auto scrollbar-thin"><McpPatPage onOpenSettings={() => window.dispatchEvent(new CustomEvent("colabora-modal", { detail: { kind: "settings", settingsTab: "Agents" } }))} /></div></Shell>;
}
