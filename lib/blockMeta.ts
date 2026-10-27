import type { BlockType } from "@/lib/types";

export const MARKDOWN_SHORTCUTS: { match: RegExp; type: BlockType }[] = [
  { match: /^#$/, type: "heading1" }, { match: /^##$/, type: "heading2" },
  { match: /^###$/, type: "heading3" }, { match: /^-$/, type: "bulleted" },
  { match: /^\*$/, type: "bulleted" }, { match: /^\+$/, type: "bulleted" },
  { match: /^1\.$/, type: "numbered" }, { match: /^\[\]$/, type: "todo" },
  { match: /^\[ \]$/, type: "todo" }, { match: /^>$/, type: "toggle" },
  { match: /^"$/, type: "quote" }, { match: /^```$/, type: "code" },
];
export const CODE_LANGUAGES = ["plaintext", "javascript", "typescript", "python", "ruby", "bash", "yaml", "json", "html", "css", "sql", "go", "rust", "java", "c", "c++", "cpp", "csharp", "php", "swift", "kotlin", "markdown"];
