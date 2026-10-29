import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import refresh from "eslint-plugin-react-refresh";
import a11y from "eslint-plugin-jsx-a11y";

export default defineConfig([
  globalIgnores([".next/**", "dist/**", "out/**", "build/**", "public/sw.js", "supabase/functions/**", "agent/**", "bridge/**", "connect/**", ".local/**", ".superpowers/**", ".claude/**"]),
  ...tseslint.configs.recommended,
  { files: ["**/*.{ts,tsx}"], plugins: { "react-hooks": hooks }, rules: hooks.configs.recommended.rules },
  { files: ["app/**/*.tsx", "components/**/*.tsx", "lib/**/*.tsx"],
    plugins: { "jsx-a11y": a11y, "react-refresh": refresh },
    settings: { "jsx-a11y": { components: { Link: "a" }, attributes: { href: ["to"] } } },
    rules: { ...a11y.flatConfigs.strict.rules, "jsx-a11y/anchor-is-valid": ["error", { components: ["Link"], specialLink: ["to"], aspects: ["noHref", "invalidHref", "preferButton"] }], "react-refresh/only-export-components": ["error", { allowConstantExport: true }] },
  },
  // The card entry mounts its own React root and exports nothing: Fast Refresh does not apply to it.
  { files: ["components/agents/card/main.tsx"], rules: { "react-refresh/only-export-components": "off" } },
]);
