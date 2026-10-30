// Domain types of the workspace. Every persisted shape lives here.
// Optional fields are optional in the persisted data: their absence means the
// default noted in the comment. A field marked "only type X" is meaningful for
// that block or property type only; other types ignore it.

// ---------------------------------------------------------------------------
// Actors (people and agents)
// ---------------------------------------------------------------------------

export interface Actor {
  id: string;                  // auth user id (people and agents are both auth users)
  type: "human" | "agent";
  name?: string;
  runId?: string;              // agent: run that produced the change
}

// Who made the last edit to a block or row. Courtesy data for the UI; the
// authoritative record lives on the server.
export interface BlockAttr {
  by: "human" | "agent";
  id: string;                  // actor id
  runId?: string;              // agent: run id
  at: number;                  // epoch ms
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type BlockType =
  | "paragraph"   // plain text
  | "heading1"    // level-1 heading
  | "heading2"    // level-2 heading
  | "heading3"    // level-3 heading
  | "todo"        // checkbox + text
  | "bulleted"    // bullet
  | "numbered"    // numbered list (the ordinal is computed at render time)
  | "toggle"      // collapsible: folds the following blocks with a greater indent
  | "quote"       // quote
  | "callout"     // highlighted box with an emoji
  | "code"        // code block (html = plain text of the code)
  | "divider"     // horizontal rule, no text
  | "image"       // image by url or fileId
  | "video"       // video (file, YouTube or Vimeo)
  | "audio"       // audio
  | "file"        // downloadable file
  | "embed"       // sandboxed generic iframe, or a named provider (embedProvider)
  | "bookmark"    // link card
  | "table"       // simple table (not a database)
  | "equation"    // block-level LaTeX equation
  | "columns"     // column layout; each column has its own blocks
  | "toc"         // table of contents generated from the headings
  | "breadcrumb"  // chain of page ancestors as links
  | "button"      // configurable button that runs actions when pressed
  | "database"    // inline database (pageId -> page with .database)
  | "synced"      // synced block: mirrors the shared content of an original
  | "page";       // link to a subpage rendered inline

// Named embed providers: turn a pasted URL into the right iframe URL.
export type EmbedProvider =
  | "figma"
  | "maps"
  | "tweet"
  | "codepen"
  | "pdf"
  | "loom"
  | "miro";

// Action a button block runs when pressed.
export type ButtonAction =
  | { id: string; kind: "insertBlocks"; blocks: Block[] }             // inserts copies of these blocks below the button
  | { id: string; kind: "openPage"; pageId: string | null }           // navigates to the page (null = not configured)
  | {
      id: string;
      kind: "agentTask";                                               // hands the row to an agent (handled by the agent layer)
      mode: "new" | "continue" | "stop" | "approve";
      agentId?: string;
      message?: string;
    };

// Text colors ("gray"…"red") and background colors ("bg-gray"…"bg-red") of a block.
export type BlockColor =
  | "default"
  | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red"
  | "bg-gray" | "bg-brown" | "bg-orange" | "bg-yellow" | "bg-green" | "bg-blue"
  | "bg-purple" | "bg-pink" | "bg-red";

export interface Block {
  id: string;                 // nanoid(12), unique across the workspace
  type: BlockType;
  html: string;               // rich text as sanitized HTML; "" if empty
  indent: number;             // visual nesting level, 0..n; 0 by default
  key?: string;               // stable key for keyed sections (e.g. "brief:goal"); empty for ordinary blocks
  rev?: number;               // server-assigned revision of this block; absent until the server has seen it
  attr?: BlockAttr;           // who made the last edit (UI courtesy data)
  color?: BlockColor;         // absent = "default"
  checked?: boolean;          // todo: checked
  collapsed?: boolean;        // toggle or toggleable heading: folded
  toggleable?: boolean;       // heading1/2/3: rendered as a collapsible heading
  language?: string;          // code: language identifier
  icon?: string;              // callout: emoji
  url?: string;               // image / bookmark / video / audio / file / embed
  fileId?: string;            // id of the uploaded blob (IndexedDB / Storage); replaces url
  caption?: string;           // image / video / audio / embed: caption
  width?: number;             // image: width in % of the container
  align?: "left" | "center" | "right"; // image: alignment
  fileName?: string;          // file: displayed name
  fileSize?: number;          // file: bytes
  pageId?: string;            // page / database: id of the referenced page
  linkedViews?: DbView[];     // database link: views owned by this block, rows remain in pageId
  bookmarkTitle?: string;     // bookmark: fetched title
  bookmarkDescription?: string; // bookmark: fetched description
  table?: string[][];         // table: rows of cells; each cell is sanitized HTML
  tableHeaderRow?: boolean;   // table: the first row is a header
  tableHeaderCol?: boolean;   // table: the first column is a header
  equation?: string;          // equation: LaTeX source
  columns?: ColumnData[];     // columns: the columns with their blocks
  embedProvider?: EmbedProvider; // embed: named provider; absent = generic iframe
  buttonLabel?: string;       // button: label
  buttonActions?: ButtonAction[]; // button: actions in execution order
  // synced: id of the ORIGINAL block this block mirrors.
  // Absent or null on the original; set on every copy.
  syncedFrom?: string | null;
}

export interface ColumnData {
  id: string;        // nanoid(12)
  width?: number;    // flex proportion; absent = all equal
  blocks: Block[];   // blocks owned by the column (real structural nesting)
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "person"
  | "files"
  | "createdTime"
  | "lastEditedTime"
  | "createdBy"       // computed from the row (actor who created it)
  | "lastEditedBy"    // computed from the row (actor of the last edit)
  | "relation"
  | "rollup"
  | "formula"
  | "id"              // unique auto-incrementing id per row, optional prefix (TASK-1)
  | "agentStatus"     // computed from the agent layer; never stored in cells
  | "agentDelegate"   // computed from the agent layer; never stored in cells
  | "ai"              // a value an agent writes on request; a person may overwrite it
  | "button";         // per-row button that runs a ButtonAction

export interface SelectOption {
  id: string;          // nanoid(12)
  name: string;
  color: BlockColor;
  group?: "todo" | "inProgress" | "complete"; // status: option group; reserved, not used by the UI
}

export type RollupFunction =
  | "count"
  | "countValues"
  | "sum"
  | "average"
  | "min"
  | "max"
  | "showOriginal";

export interface DbProperty {
  id: string;             // nanoid(12); the title property ALWAYS has the literal id "title"
  name: string;
  type: PropertyType;
  options?: SelectOption[];   // select / multiSelect / status
  relationDbId?: string;      // relation: id of the target database PAGE ("self" in templates = this database)
  relationPropId?: string;    // rollup: relation property of this database to follow
  targetPropId?: string;      // rollup: property of the target database to aggregate
  rollupFn?: RollupFunction;  // rollup: aggregation function
  formula?: string;           // formula: expression
  numberFormat?: "plain" | "percent" | "dollar" | "euro"; // number / rollup / formula: format; absent = plain
  idPrefix?: string;          // id: displayed prefix ("TASK" -> TASK-1)
  nextId?: number;            // id: next counter to assign
  buttonLabel?: string;       // button: label
  buttonActions?: ButtonAction[]; // button: actions in execution order
  aiPrompt?: string;         // ai: instruction, at most 4000 characters
  aiInputs?: string[];       // ai: input property ids; absent means all non-AI properties
  aiAgentId?: string;        // ai: agent id; absent means the workspace's platform agent
}

export interface AiCellValue {
  text: string;
  error?: string;            // at most 300 characters; a new fill retries the row
  by: "agent" | "human";
  id: string;               // auth user id of the writer
  agentId?: string;
  runId?: string;
  taskId?: string;
  at: number;               // epoch milliseconds
}

export interface DbRow {
  id: string;                        // nanoid(12)
  pageId: string;                    // id of the page that IS this row (always exists in pages)
  cells: Record<string, unknown>;    // propertyId -> value (shapes per type in the database spec)
  // Sub-items: id of the parent row. Table and list views nest; the others show flat.
  // When the parent is deleted, children move to the top level (parentRowId = undefined).
  parentRowId?: string | null;
  createdBy?: string;                // actor id that created the row
  lastEditedBy?: string;             // actor id of the last edit
  rev?: number;                      // server-assigned revision of this row
}

export type DbViewType =
  | "table"
  | "board"
  | "list"
  | "gallery"
  | "calendar"
  | "timeline";

export type AggregationFn =
  | "none"
  | "count"
  | "countValues"
  | "countEmpty"
  | "countNotEmpty"
  | "percentEmpty"
  | "percentNotEmpty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "checked"
  | "unchecked"
  | "percentChecked";

export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "isEmpty"
  | "isNotEmpty"
  | "gt"
  | "lt"
  | "checked"
  | "unchecked";

export interface FilterCondition {
  id: string;             // nanoid(12)
  propertyId: string;
  operator: FilterOperator;
  value?: string;         // operand; absent for isEmpty/isNotEmpty/checked/unchecked
}

export interface SortRule {
  propertyId: string;
  direction: "asc" | "desc";
}

// Conditional color rule per view: rows/cards matching the condition get a
// palette background. The first matching rule wins.
export interface ColorRule {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value?: string;
  color: string; // palette key: gray | brown | orange | yellow | green | blue | purple | pink | red
}

export interface DbView {
  id: string;                    // nanoid(12)
  name: string;
  type: DbViewType;
  groupBy?: string;              // propertyId to group by (board, grouped table)
  sorts?: SortRule[];            // sort rules; the first is primary; absent = []
  filters?: FilterCondition[];   // absent = []
  filterConjunction?: "and" | "or"; // how filters combine; absent = "and"
  dateProp?: string;             // calendar / timeline: start date property
  endDateProp?: string;          // timeline: end date property (optional)
  hiddenProps?: string[];        // properties hidden in this view; absent = []
  aggregations?: Record<string, AggregationFn>; // propertyId -> footer calculation (table); absent = {}
  colWidths?: Record<string, number>; // table: propertyId -> width in px
  propOrder?: string[];          // property order in this view
  boardOrder?: Record<string, string[]>; // board: group key -> ordered row ids
  colorRules?: ColorRule[];      // conditional color rules
}

// Reusable row template: fills cells and page content of a new row.
export interface RowTemplate {
  id: string;
  name: string;
  icon?: string | null;           // page icon of the row; null = no explicit icon
  cells: Record<string, unknown>; // never contains "title" nor properties of type "id"
  blocks: Block[];
}

export interface Database {
  id: string;                 // nanoid(12), distinct from the page id
  properties: DbProperty[];   // the first is usually the one with id "title"
  rows: DbRow[];              // creation order
  views: DbView[];            // at least one
  rowTemplates?: RowTemplate[];
  // Locked: properties and views cannot be edited; cells can.
  locked?: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export interface PageComment {
  id: string;
  body: string;        // plain text or Markdown, already trimmed; never HTML
  author?: string;     // legacy display name/email of the author; absent in local use
  authorId: string;    // actor id (person or agent)
  authorType: "human" | "agent";
  runId?: string;      // agent: run that wrote the comment
  parentId?: string;   // reply to another comment
  anchorId?: string;   // anchored to a block; absent = page comment
  createdAt: number;   // epoch ms
  resolved?: boolean;  // absent = false
  blockId?: string;    // anchored to a block (same meaning as anchorId; kept for compatibility)
}

// Reminder: while the app is open, due reminders raise a browser notification
// + an in-app toast; with the app closed, Web Push.
export interface Reminder {
  id: string;
  date: string;        // local ISO date-time without zone, e.g. "2026-08-13T09:00"
  pageId: string;
  blockId?: string;
  text: string;
  createdAt: number;
  notified?: boolean;  // already notified
  dismissed?: boolean; // hidden in the bell list
}

export type ThemeMode = "light" | "dark" | "system";
export type PageFont = "default" | "serif" | "mono";

// User settings of the workspace (settings modal).
export interface WorkspaceSettings {
  theme: ThemeMode;
  defaultFont: PageFont;      // font new pages get
  smallTextDefault: boolean;  // small text by default on new pages
  fullWidthDefault: boolean;  // full width by default on new pages
  spellcheck: boolean;        // browser spellcheck in the editor
}

// Snapshot of a page's content for version history.
export interface PageVersion {
  id: string;
  createdAt: number;
  title: string;
  blocks: Block[];
  database?: Database;  // present when the page is a database
  auto?: boolean;       // true if captured automatically
  author?: Actor;       // who saved it
  runId?: string;       // agent run that saved it
  label?: string;       // e.g. "before RUN-15"
}

export interface Page {
  id: string;                 // nanoid(12)
  title: string;              // "" = untitled (the UI shows "Untitled")
  icon: string | null;        // emoji
  cover: string | null;       // cover image url
  coverPosition?: number;     // 0..100, vertical focal point; 50 by default
  parentId: string | null;    // null = root page
  blocks: Block[];
  database?: Database;        // present <=> the page is a database
  isFavorite: boolean;
  isDeleted: boolean;         // true = in the trash (soft delete)
  fullWidth: boolean;
  smallText: boolean;
  locked?: boolean;           // locked page (read-only in the editor)
  font?: PageFont;            // absent = "default"
  comments?: PageComment[];
  versions?: PageVersion[];   // newest first; at most 50
  revision?: number;          // read-only mirror of the server column
  lastEditedBy?: Actor;       // read-only, sealed by the server
  createdAt: number;          // epoch ms
  updatedAt: number;          // epoch ms
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface WorkspaceState {
  pages: Record<string, Page>;          // flat map id -> page (includes trashed pages)
  rootOrder: string[];                  // order of root pages (parentId === null, not deleted)
  expanded: Record<string, boolean>;    // expanded/collapsed state per page in the sidebar
  // Shared content of synced blocks, by id of the ORIGINAL block.
  // Original and copies render and edit the same entry.
  syncedBlocks?: Record<string, Block[]>;
  reminders?: Reminder[];
  settings?: WorkspaceSettings;         // absent = DEFAULT_SETTINGS
  members?: Actor[];                    // non-persisted cache of workspace people
  agents?: Actor[];                     // non-persisted cache of workspace agents
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateRow {
  cells: Record<string, unknown>;
}

export interface TemplatePlan {
  title: string;
  icon: string | null;
  blocks?: Block[];
  database?: { properties: DbProperty[]; views: DbView[]; rows: TemplateRow[]; rowTemplates?: RowTemplate[] };
}

export interface Template {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: "Personal" | "Work" | "Database";
  build: () => TemplatePlan;
}
