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
export const LIST_TYPES: BlockType[] = ["todo", "bulleted", "numbered", "toggle"];

// Bloques sin superficie de texto editable (no reciben caret, no se fusionan,
// las flechas los saltan).
export const NON_TEXT: BlockType[] = [
  "divider", "image", "video", "audio", "file", "embed", "code", "page",
  "bookmark", "table", "equation", "columns", "toc", "breadcrumb", "button",
  "database", "synced",
];

export const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: "Text", heading1: "Heading 1", heading2: "Heading 2",
  heading3: "Heading 3", todo: "To-do list", bulleted: "Bulleted list",
  numbered: "Numbered list", toggle: "Toggle list", quote: "Quote",
  callout: "Callout", code: "Code", divider: "Divider", image: "Image",
  video: "Video", audio: "Audio", file: "File", embed: "Embed",
  bookmark: "Bookmark", table: "Table", equation: "Equation",
  columns: "Columns", toc: "Table of contents", breadcrumb: "Breadcrumb",
  button: "Button", database: "Database", synced: "Synced block", page: "Page",
};



export interface SlashItem { type: BlockType; title: string; description: string; keywords: string[]; group: "Basic" | "Media" | "Advanced"; icon: string }
export const SLASH_ITEMS: SlashItem[] = [
  { type: "paragraph", title: "Text", description: "Just start writing with plain text.", keywords: ["text", "paragraph", "plain"], group: "Basic", icon: "📝" },
  { type: "heading1", title: "Heading 1", description: "Big section heading.", keywords: ["h1", "heading", "title", "big"], group: "Basic", icon: "H₁" },
  { type: "heading2", title: "Heading 2", description: "Medium section heading.", keywords: ["h2", "heading", "subtitle"], group: "Basic", icon: "H₂" },
  { type: "heading3", title: "Heading 3", description: "Small section heading.", keywords: ["h3", "heading", "small"], group: "Basic", icon: "H₃" },
  { type: "todo", title: "To-do list", description: "Track tasks with a to-do list.", keywords: ["todo", "task", "checkbox"], group: "Basic", icon: "☑" },
  { type: "bulleted", title: "Bulleted list", description: "Create a simple bulleted list.", keywords: ["bullet", "list"], group: "Basic", icon: "•" },
  { type: "numbered", title: "Numbered list", description: "Create a list with numbering.", keywords: ["number", "list"], group: "Basic", icon: "1." },
  { type: "toggle", title: "Toggle list", description: "Toggles can hide and show content.", keywords: ["toggle", "collapse"], group: "Basic", icon: "▸" },
  { type: "quote", title: "Quote", description: "Capture a quote.", keywords: ["quote", "cite"], group: "Basic", icon: "❞" },
  { type: "divider", title: "Divider", description: "Visually divide blocks.", keywords: ["divider", "line"], group: "Basic", icon: "—" },
  { type: "callout", title: "Callout", description: "Make writing stand out.", keywords: ["callout", "note"], group: "Basic", icon: "💡" },
  { type: "code", title: "Code", description: "Capture a code snippet.", keywords: ["code", "snippet"], group: "Advanced", icon: "⌘" },
];
export const filterSlashItems = (query: string) => SLASH_ITEMS.filter((item) => !query.trim() || item.title.toLowerCase().includes(query.toLowerCase().trim()) || item.keywords.some((key) => key.includes(query.toLowerCase().trim())));
