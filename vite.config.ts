import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    "@": fileURLToPath(new URL(".", import.meta.url)),
  } },
  build: {
    manifest: true,
    rollupOptions: { input: {
      workspace: fileURLToPath(new URL("./index.html", import.meta.url)),
      card: fileURLToPath(new URL("./apps/card.html", import.meta.url)),
    } },
  },
});
