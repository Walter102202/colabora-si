import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for pure logic in lib/: no React rendering, no network.
// The default environment is node; suites that need DOMParser/Selection
// enable happy-dom with a `@vitest-environment` docblock per file.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      // mirrors the "@/*" -> "./*" mapping of tsconfig.json
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
