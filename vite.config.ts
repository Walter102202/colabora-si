import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "next/navigation": fileURLToPath(new URL("./lib/routerCompat.ts", import.meta.url)),
    } },
    // The agent store retains its frozen public environment contract.
    define: {
      "process.env.NEXT_PUBLIC_MCP_URL": JSON.stringify(env.VITE_MCP_URL ?? ""),
      "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(env.VITE_SUPABASE_URL ?? ""),
    },
    build: {
      manifest: true,
      rollupOptions: { input: {
        workspace: fileURLToPath(new URL("./index.html", import.meta.url)),
        card: fileURLToPath(new URL("./apps/card.html", import.meta.url)),
      } },
    },
  };
});
