import type React from "react";
import type { EditableHandle } from "@/components/Editable";
import type { Block, BlockType } from "@/lib/types";
import { createBlock } from "@/lib/factories";
import { stripHtml } from "@/lib/utils";
import { NON_TEXT } from "@/lib/blockMeta";
export interface BlockOps {
  pageId: string;
  register: (id: string, handle: EditableHandle | null) => void;
  handleKeyDown: (id: string, e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleInput: (id: string, html: string) => void;
  handlePaste: (id: string, e: React.ClipboardEvent) => void;
  saveBlock: (id: string, html: string) => void;
  setActive: (id: string | null) => void;
  toggleChecked: (id: string) => void;
  toggleCollapsed: (id: string) => void;
  openBlockMenu: (id: string, anchor: HTMLElement) => void;
  openComments?: (id: string, anchor: HTMLElement) => void;
  onBlockMouseDown: (id: string, e: React.MouseEvent) => void;
  addBlockBelow: (id: string) => void;
  updateBlock: (id: string, patch: Partial<Block>) => void;
  onDragStart: (id: string) => void;
  onDragOverBlock: (id: string, e: React.DragEvent) => void;
  onDrop: () => void;
  dropTarget: { id: string; position: "above" | "below" } | null;
  draggingId: string | null;
  numbering: Record<string, number>;
  locked?: boolean;
}
function computeVisible(blocks: Block[]): { visible: Block[]; numbering: Record<string, number> } {
  const vis: Block[] = [];
  let collapseThreshold: number | null = null;    // toggle plegado: indent del toggle
  let headingCollapseLevel: number | null = null; // encabezado-toggle plegado: su nivel 1..3
  const headingLevel = (b: Block) =>
    b.type === "heading1" ? 1 : b.type === "heading2" ? 2 : b.type === "heading3" ? 3 : null;

  for (const b of blocks) {
    const lvl = headingLevel(b);
    // Un encabezado-toggle plegado oculta todo hasta el siguiente encabezado de
    // rango igual o superior, sin mirar el indent.
    if (headingCollapseLevel !== null) {
      if (lvl !== null && lvl <= headingCollapseLevel) headingCollapseLevel = null;
      else continue;
    }
    // Un toggle plegado oculta los bloques siguientes con indent mayor que el suyo.
    if (collapseThreshold !== null) {
      if (b.indent > collapseThreshold) continue;
      else collapseThreshold = null;
    }
    vis.push(b);
    if (b.type === "toggle" && b.collapsed) collapseThreshold = b.indent;
    if (lvl !== null && b.toggleable && b.collapsed) headingCollapseLevel = lvl;
  }

  // Ordinales: un contador por nivel de indent; se reinicia cuando aparece un
  // bloque no numerado en ese nivel; los contadores de niveles más profundos se
  // descartan al volver a un nivel menos profundo.
  const num: Record<string, number> = {};
  const counters: Record<number, number> = {};
  for (const b of vis) {
    if (b.type === "numbered") {
      counters[b.indent] = (counters[b.indent] ?? 0) + 1;
      num[b.id] = counters[b.indent];
      for (const k of Object.keys(counters)) if (Number(k) > b.indent) delete counters[Number(k)];
    } else {
      delete counters[b.indent];
    }
  }
  return { visible: vis, numbering: num };
}
export function visibleBlocks(blocks: Block[]): Block[] { return computeVisible(blocks).visible; }
export function numbering(blocks: Block[]): Record<string, number> { return computeVisible(blocks).numbering; }
export function splitBlock(blocks: Block[], id: string, offsetHtml: { before: string; after: string }): Block[] {
  const index = blocks.findIndex((b) => b.id === id), block = blocks[index];
  if (!block) return blocks;
  if (!stripHtml(offsetHtml.before + offsetHtml.after).trim() && ["todo", "bulleted", "numbered", "toggle", "quote", "callout"].includes(block.type)) return blocks.map((b) => b.id === id ? { ...b, type: "paragraph", checked: undefined, collapsed: undefined } : b);
  const type = ["bulleted", "numbered", "todo"].includes(block.type) ? block.type : "paragraph";
  const next = createBlock(type, { html: offsetHtml.after, indent: block.indent + (block.type === "toggle" ? 1 : 0), ...(type === "todo" ? { checked: false } : {}) });
  const result = blocks.map((b) => b.id === id ? { ...b, html: offsetHtml.before, ...(block.type === "toggle" ? { collapsed: false } : {}) } : b);
  result.splice(index + 1, 0, next);
  return result;
}
export function mergeWithPrevious(blocks: Block[], id: string): Block[] {
  const index = blocks.findIndex((b) => b.id === id), block = blocks[index];
  if (!block) return blocks;
  if (block.type !== "paragraph") return applyType(blocks, id, "paragraph");
  if (index === 0) return outdentBlock(blocks, id);
  const previous = blocks[index - 1];
  if (NON_TEXT.includes(previous.type)) return blocks.filter((b) => b.id !== previous.id);
  return blocks.filter((b) => b.id !== id).map((b) => b.id === previous.id ? { ...b, html: b.html + block.html } : b);
}
export function indentBlock(blocks: Block[], id: string): Block[] {
  const index = blocks.findIndex((b) => b.id === id), block = blocks[index];
  if (!block || index === 0) return blocks;
  const indent = Math.min(block.indent + 1, blocks[index - 1].indent + 1);
  return indent === block.indent ? blocks : blocks.map((b) => b.id === id ? { ...b, indent } : b);
}
export function outdentBlock(blocks: Block[], id: string): Block[] {
  const block = blocks.find((b) => b.id === id);
  return !block || !block.indent ? blocks : blocks.map((b) => b.id === id ? { ...b, indent: Math.max(0, b.indent - 1) } : b);
}
export function applyType(blocks: Block[], id: string, type: BlockType): Block[] {
  const block = blocks.find((b) => b.id === id);
  if (!block || block.type === type) return blocks;
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = type === "code" ? stripHtml(block.html) : block.type === "code" ? escape(block.html) : block.html;
  if (type === "divider") html = "";
  return blocks.map((b) => b.id === id ? { ...b, type, html, ...(type === "paragraph" ? { checked: undefined, collapsed: undefined } : {}), ...(type === "code" ? { language: block.language ?? "plaintext" } : {}) } : b);
}
