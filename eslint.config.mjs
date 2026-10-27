import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // service worker: runs in a worker global scope, not in the browser page or Node
    "public/sw.js",
    // Deno (Edge Functions) and standalone Node processes have their own toolchains
    "supabase/functions/**",
    "agent/**",
    "bridge/**",
    // local, never-versioned folders
    ".local/**",
    ".superpowers/**",
  ]),
]);

export default eslintConfig;
