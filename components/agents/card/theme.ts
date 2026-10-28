import type { HostContext } from "@/lib/agentCardHost";

// Maps the host's style variables (MCP Apps hostContext.styles.variables) onto
// the card's own tokens, which the panel views use through Tailwind
// (bg-bg, text-text-secondary, border-border…). Anything the host does not
// send keeps the card's default for the current theme.
const TOKENS: [ours: string, host: string][] = [
  ["--bg", "--color-background-primary"],
  ["--bg-secondary", "--color-background-secondary"],
  ["--text", "--color-text-primary"],
  ["--text-secondary", "--color-text-secondary"],
  ["--text-tertiary", "--color-text-tertiary"],
  ["--border", "--color-border-tertiary"],
  ["--border-strong", "--color-border-secondary"],
  ["--ring", "--color-ring-primary"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
];

const SIDES = ["top", "right", "bottom", "left"] as const;

export function applyHostContext(context: HostContext, doc: Document = document): void {
  const root = doc.documentElement;
  if (context.theme === "dark" || context.theme === "light") root.classList.toggle("dark", context.theme === "dark");
  const vars = context.styles?.variables;
  if (vars) {
    for (const [ours, theirs] of TOKENS) {
      const value = vars[theirs];
      if (typeof value === "string" && value) root.style.setProperty(ours, value);
    }
  }
  const fonts = context.styles?.css?.fonts;
  if (typeof fonts === "string") {
    let style = doc.getElementById("host-fonts");
    if (!style) {
      style = doc.createElement("style");
      style.id = "host-fonts";
      doc.head.appendChild(style);
    }
    style.textContent = fonts;
  }
  if (typeof context.locale === "string" && context.locale) root.lang = context.locale;
  const insets = context.safeAreaInsets;
  if (insets) {
    for (const side of SIDES) root.style.setProperty(`--safe-${side}`, `${Math.max(0, Number(insets[side]) || 0)}px`);
  }
}

// Before the host says anything: follow the system preference.
export function applySystemTheme(doc: Document = document): void {
  const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  doc.documentElement.classList.toggle("dark", dark);
}
