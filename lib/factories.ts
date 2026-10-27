import { nanoid } from "nanoid";
import type { Block, BlockType, Database, DbProperty, DbView, Page, WorkspaceSettings } from "@/lib/types";

export function newId(): string {
  return nanoid(12);
}

export function createBlock(type: BlockType = "paragraph", patch: Partial<Block> = {}): Block {
  return { id: newId(), type, html: "", indent: 0, ...patch };
}

export function createPage(patch: Partial<Page> = {}): Page {
  const now = Date.now();
  return {
    id: newId(),
    title: "",
    icon: null,
    cover: null,
    coverPosition: 50,
    parentId: null,
    blocks: [createBlock("paragraph")],
    isFavorite: false,
    isDeleted: false,
    fullWidth: false,
    smallText: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

export function createDatabase(patch: Partial<Database> = {}): Database {
  const statusId = newId();
  return {
    id: newId(),
    properties: [
      { id: "title", name: "Name", type: "text" },
      {
        id: statusId,
        name: "Status",
        type: "select",
        options: [
          { id: newId(), name: "Not started", color: "red" },
          { id: newId(), name: "In progress", color: "yellow" },
          { id: newId(), name: "Done", color: "green" },
        ],
      },
      { id: newId(), name: "Date", type: "date" },
    ],
    rows: [],
    views: [
      { id: newId(), name: "Table", type: "table", sorts: [], filters: [] },
      { id: newId(), name: "Board", type: "board", groupBy: statusId, sorts: [], filters: [] },
    ],
    ...patch,
  };
}

export function createProperty(patch: Partial<DbProperty> = {}): DbProperty {
  return { id: newId(), name: "Property", type: "text", ...patch };
}

export function createView(patch: Partial<DbView> = {}): DbView {
  return { id: newId(), name: "Table", type: "table", sorts: [], filters: [], ...patch };
}

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  theme: "system",
  defaultFont: "default",
  smallTextDefault: false,
  fullWidthDefault: false,
  spellcheck: true,
};
