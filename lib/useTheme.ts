"use client";
import { useSyncExternalStore } from "react";
import type { ThemeMode } from "@/lib/types";

export function getThemeMode(): ThemeMode {
  try { const theme = localStorage.getItem("colabora-theme"); if (theme === "dark" || theme === "light") return theme; } catch {}
  return "system";
}
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches));
  try { if (mode === "system") localStorage.removeItem("colabora-theme"); else localStorage.setItem("colabora-theme", mode); } catch {}
}
function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
export function useTheme(): { theme: "light" | "dark"; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains("dark") ? "dark" : "light", () => "light") as "light" | "dark";
  return { theme, toggle: () => applyThemeMode(theme === "dark" ? "light" : "dark") };
}
