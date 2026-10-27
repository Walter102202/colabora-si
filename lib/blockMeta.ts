import type { BlockType, EmbedProvider } from "@/lib/types";

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



export interface SlashItem { type: BlockType; title: string; description: string; keywords: string[]; group: "Basic" | "Media" | "Advanced"; icon: string; shortcut?: string; variant?: "linked" | "syncedCopy"; provider?: EmbedProvider }
export const SLASH_ITEMS: SlashItem[] = [
  {"type":"paragraph","title":"Text","description":"Just start writing with plain text.","keywords":["text","paragraph","plain"],"group":"Basic","icon":"📝"},
  {"type":"heading1","title":"Heading 1","description":"Big section heading.","keywords":["h1","heading","title","big"],"group":"Basic","icon":"🇭"},
  {"type":"heading2","title":"Heading 2","description":"Medium section heading.","keywords":["h2","heading","subtitle"],"group":"Basic","icon":"🇭"},
  {"type":"heading3","title":"Heading 3","description":"Small section heading.","keywords":["h3","heading","small"],"group":"Basic","icon":"🇭"},
  {"type":"todo","title":"To-do list","description":"Track tasks with a checkbox.","keywords":["todo","task","checkbox","check"],"group":"Basic","icon":"☑️"},
  {"type":"bulleted","title":"Bulleted list","description":"Create a simple bulleted list.","keywords":["bullet","list","unordered","ul"],"group":"Basic","icon":"•"},
  {"type":"numbered","title":"Numbered list","description":"Create a numbered list.","keywords":["number","ordered","list","ol"],"group":"Basic","icon":"1."},
  {"type":"toggle","title":"Toggle list","description":"Collapsible content.","keywords":["toggle","collapse","expand","dropdown"],"group":"Basic","icon":"▸"},
  {"type":"quote","title":"Quote","description":"Capture a quote.","keywords":["quote","blockquote","citation"],"group":"Basic","icon":"❝"},
  {"type":"callout","title":"Callout","description":"Make writing stand out.","keywords":["callout","info","note","highlight"],"group":"Basic","icon":"💡"},
  {"type":"divider","title":"Divider","description":"Visually divide blocks.","keywords":["divider","line","separator","hr"],"group":"Basic","icon":"―"},
  {"type":"code","title":"Code","description":"Capture a code snippet.","keywords":["code","snippet","pre"],"group":"Advanced","icon":"💻"},
  {"type":"image","title":"Image","description":"Embed an image by URL.","keywords":["image","picture","photo","img"],"group":"Media","icon":"🖼️"},
  {"type":"video","title":"Video","description":"Embed a video by URL (YouTube, Vimeo, .mp4…).","keywords":["video","youtube","vimeo","movie","mp4","media"],"group":"Media","icon":"🎬"},
  {"type":"audio","title":"Audio","description":"Embed an audio clip by URL (.mp3, .wav…).","keywords":["audio","sound","music","mp3","podcast","media"],"group":"Media","icon":"🎵"},
  {"type":"file","title":"File","description":"Add a downloadable file link.","keywords":["file","attachment","download","document","pdf"],"group":"Media","icon":"📎"},
  {"type":"embed","title":"Embed","description":"Embed any page or app in a sandboxed frame.","keywords":["embed","iframe","frame","widget","google","figma"],"group":"Media","icon":"🌐"},
  {"type":"embed","title":"Figma","description":"Embed a Figma file or prototype.","keywords":["figma","design","prototype","mockup","embed"],"group":"Media","icon":"🎨","provider":"figma"},
  {"type":"embed","title":"Google Maps","description":"Embed an interactive map.","keywords":["maps","google maps","map","location","place","embed"],"group":"Media","icon":"🗺️","provider":"maps"},
  {"type":"embed","title":"Tweet","description":"Embed a post from Twitter / X.","keywords":["tweet","twitter","x","post","embed"],"group":"Media","icon":"🐦","provider":"tweet"},
  {"type":"embed","title":"CodePen","description":"Embed an interactive CodePen.","keywords":["codepen","pen","code","demo","snippet","embed"],"group":"Media","icon":"🖊️","provider":"codepen"},
  {"type":"embed","title":"PDF","description":"Embed a PDF for inline viewing.","keywords":["pdf","document","paper","acrobat","embed"],"group":"Media","icon":"📕","provider":"pdf"},
  {"type":"embed","title":"Loom","description":"Embed a Loom screen recording.","keywords":["loom","recording","screencast","video","embed"],"group":"Media","icon":"📹","provider":"loom"},
  {"type":"embed","title":"Miro","description":"Embed a Miro whiteboard.","keywords":["miro","board","whiteboard","canvas","embed"],"group":"Media","icon":"🧩","provider":"miro"},
  {"type":"bookmark","title":"Web bookmark","description":"Save a link as a visual bookmark.","keywords":["bookmark","link","url","web"],"group":"Media","icon":"🔖"},
  {"type":"page","title":"Page","description":"Embed a sub-page inside this page.","keywords":["page","subpage","document"],"group":"Advanced","icon":"📄"},
  {"type":"table","title":"Table","description":"Add a simple table.","keywords":["table","grid","rows","columns","cells"],"group":"Advanced","icon":"▦"},
  {"type":"columns","title":"Columns","description":"Lay blocks out in side-by-side columns.","keywords":["columns","layout","side","grid","two","three"],"group":"Advanced","icon":"▥"},
  {"type":"equation","title":"Block equation","description":"Display a TeX / LaTeX math expression.","keywords":["equation","math","latex","tex","formula"],"group":"Advanced","icon":"∑"},
  {"type":"toc","title":"Table of contents","description":"Auto-generated outline of this page's headings.","keywords":["toc","table","contents","outline","index"],"group":"Advanced","icon":"📑"},
  {"type":"breadcrumb","title":"Breadcrumb","description":"Show this page's location in the workspace.","keywords":["breadcrumb","path","location","ancestors","navigation"],"group":"Advanced","icon":"🧭"},
  {"type":"button","title":"Button","description":"Run actions with one click (insert blocks, open a page).","keywords":["button","action","click","automation","template"],"group":"Advanced","icon":"🔘"},
  {"type":"database","title":"Database — Inline","description":"Embed a table / board database inside this page.","keywords":["database","board","inline","grid","db","collection"],"group":"Advanced","icon":"🗃️"},
  {"type":"database","title":"Linked view of database","description":"Show an existing database in this page.","keywords":["linked","database","reference","view of","existing"],"group":"Advanced","icon":"🔗","variant":"linked"},
  {"type":"synced","title":"Synced block","description":"A block whose content stays in sync everywhere it appears.","keywords":["synced","sync","mirror","shared","reuse"],"group":"Advanced","icon":"🔄"},
  {"type":"synced","title":"Synced block — paste copy","description":"Insert a synced copy of the block you last copied.","keywords":["synced","copy","paste","mirror","reference"],"group":"Advanced","icon":"📍","variant":"syncedCopy"},
];
export const filterSlashItems = (query: string, nested = false) => SLASH_ITEMS.filter((item) => (!nested || !["columns", "database"].includes(item.type)) && (!query.trim() || item.title.toLowerCase().includes(query.toLowerCase().trim()) || item.keywords.some((key) => key.includes(query.toLowerCase().trim()))));
