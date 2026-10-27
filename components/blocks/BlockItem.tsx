"use client";
import { memo, useCallback, useState } from "react";
import { ChevronRight, GripVertical, Plus } from "lucide-react";
import Editable, { type EditableHandle } from "@/components/Editable";
import { AttributionMargin } from "@/components/agents/AttributionMargin";
import type { Block, Page } from "@/lib/types";
import ButtonBlock from "@/components/blocks/ButtonBlock";
import type { BlockOps } from "@/lib/blockOps";
import { blockColorClass, stripHtml } from "@/lib/utils";
import { BLOCK_LABELS } from "@/lib/blockMeta";
import BlockPresence from "@/components/BlockPresence";
import BlockConflictNotice from "@/components/blocks/BlockConflictNotice";
import ColumnsBlock from "@/components/blocks/ColumnsBlock";
import TableBlock from "@/components/blocks/TableBlock";
import EquationBlock from "@/components/blocks/EquationBlock";
import BreadcrumbBlock from "@/components/blocks/BreadcrumbBlock";
import SyncedBlock from "@/components/blocks/SyncedBlock";
import PageLinkBlock from "@/components/blocks/PageLinkBlock";
import TocBlock from "@/components/blocks/TocBlock";
import InlineDatabaseBlock from "@/components/blocks/InlineDatabaseBlock";
import BookmarkBlock from "@/components/blocks/BookmarkBlock";
import MediaBlock from "@/components/blocks/MediaBlock";
import CodeBlock from "@/components/blocks/CodeBlock";
import EmojiPicker from "@/components/EmojiPicker";

interface Props { block: Block; ops: BlockOps; ordinal?: number; spellCheck: boolean; selected?: boolean; pages: Record<string, Page>; insertBlocks: (id: string, blocks: Block[]) => void; commentCount?: number }
function BlockItem({ block, ops, ordinal, spellCheck, selected, pages, insertBlocks, commentCount = 0 }: Props) {
  const [pickingIcon, setPickingIcon] = useState(false);
  const register = useCallback((handle: EditableHandle | null) => ops.register(block.id, handle), [block.id, ops]);
  const color = blockColorClass(block.color), heading = block.type.startsWith("heading");
  const placeholder = heading ? `Heading ${block.type.at(-1)}` : block.type === "todo" ? "To-do" : ["bulleted", "numbered"].includes(block.type) ? "List" : block.type === "toggle" ? "Toggle" : block.type === "quote" ? "Empty quote" : block.type === "callout" ? "Type something…" : "Type '/' for commands";
  const text = <Editable ref={register} html={block.html} placeholder={placeholder} spellCheck={spellCheck} readOnly={ops.locked} className={`block-text ${heading ? `block-${block.type} always-ph` : ""} ${block.checked ? "line-through text-text-tertiary" : ""} ${color.startsWith("tc-") ? color : ""}`} onInput={(html) => ops.handleInput(block.id, html)} onBlurSave={(html) => ops.saveBlock(block.id, html)} onKeyDown={(event) => ops.handleKeyDown(block.id, event)} onPaste={(event) => ops.handlePaste(block.id, event)} onFocus={() => ops.setActive(block.id)} />;
  let body: React.ReactNode;
  if (block.type === "button") body = <ButtonBlock block={block} ops={ops} pages={pages} onInsert={(blocks) => insertBlocks(block.id, blocks)} />;
  else if (block.type === "columns") body = <ColumnsBlock block={block} ops={ops} />;
  else if (block.type === "table") body = <TableBlock block={block} ops={ops} />;
  else if (block.type === "equation") body = <EquationBlock block={block} ops={ops} />;
  else if (block.type === "breadcrumb") body = <BreadcrumbBlock pageId={ops.pageId} pages={pages} />;
  else if (block.type === "synced") body = <SyncedBlock block={block} ops={ops} />;
  else if (block.type === "page") body = <PageLinkBlock page={pages[block.pageId ?? ""]} />;
  else if (block.type === "toc") body = <TocBlock blocks={pages[ops.pageId]?.blocks ?? []} />;
  else if (block.type === "database") body = <InlineDatabaseBlock block={block} ops={ops} pages={pages} />;
  else if (block.type === "bookmark") body = <BookmarkBlock block={block} ops={ops} />;
  else if (["image", "video", "audio", "file", "embed"].includes(block.type)) body = <MediaBlock block={block} ops={ops} />;
  else if (block.type === "divider") body = <div className="py-3"><hr className="border-border" /></div>;
  else if (block.type === "code") body = <CodeBlock block={block} ops={ops} />;
  else if (block.type === "todo") body = <div className="block-line"><input aria-label="Complete task" type="checkbox" checked={!!block.checked} disabled={ops.locked} onChange={() => ops.toggleChecked(block.id)} />{text}</div>;
  else if (block.type === "bulleted" || block.type === "numbered") body = <div className="block-line"><span className="list-marker">{block.type === "bulleted" ? "•" : `${ordinal ?? 1}.`}</span>{text}</div>;
  else if (block.type === "toggle" || (heading && block.toggleable)) body = <div className="block-line"><button className={`toggle-marker ${heading ? `marker-${block.type}` : ""}`} aria-label={block.collapsed ? "Expand block" : "Collapse block"} onClick={() => ops.toggleCollapsed(block.id)}><ChevronRight size={17} className={block.collapsed ? "" : "rotate-90"} /></button>{text}</div>;
  else if (block.type === "quote") body = <div className="quote-block">{text}</div>;
  else if (block.type === "callout") body = <div className={`callout-block ${color || "bc-gray"}`}><span className="relative"><button disabled={ops.locked} aria-label="Change callout icon" onClick={() => setPickingIcon(!pickingIcon)}>{block.icon ?? "💡"}</button>{pickingIcon && <EmojiPicker onSelect={(icon) => ops.updateBlock(block.id, { icon })} onClose={() => setPickingIcon(false)} />}</span>{text}</div>;
  else body = text;
  const drop = ops.dropTarget?.id === block.id ? ops.dropTarget.position : null;
  return <div data-block-id={block.id} className={`block-item ${selected ? "selected-block" : ""} ${ops.draggingId === block.id ? "opacity-40" : ""} ${drop ? `block-drop-${drop}` : ""}`} style={{ marginLeft: block.indent * 26 }} onMouseDownCapture={(event) => ops.onBlockMouseDown(block.id, event)} onDragOver={(event) => ops.onDragOverBlock(block.id, event)} onDrop={(event) => { if (ops.draggingId) { event.preventDefault(); event.stopPropagation(); ops.onDrop(); } }}>
    <AttributionMargin blockId={block.id} attr={block.attr} />
    <BlockPresence blockId={block.id} />
    {block.attr?.by === "agent" && <span className="agent-dot" title="Edited by an agent" />}
    {!ops.locked && <div className="block-gutter" style={{ top: block.type === "heading1" ? 22 : block.type === "heading2" ? 14 : block.type === "heading3" ? 10 : 0 }} contentEditable={false}><button aria-label="Add block below" onClick={() => ops.addBlockBelow(block.id)}><Plus size={15} /></button><button aria-label="Move or open block menu" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", block.id); const ghost = document.createElement("div"); ghost.className = "drag-ghost"; ghost.textContent = (block.type === "code" ? block.html : stripHtml(block.html)).slice(0, 60) || BLOCK_LABELS[block.type]; document.body.appendChild(ghost); event.dataTransfer.setDragImage(ghost, 0, 0); setTimeout(() => ghost.remove(), 0); ops.onDragStart(block.id); }} onDragEnd={() => ops.onDrop()} onClick={(event) => ops.openBlockMenu(block.id, event.currentTarget)}><GripVertical size={15} /></button></div>}
    <div className={color.startsWith("bc-") && block.type !== "callout" ? `${color} rounded px-2` : ""}>{body}</div>
    {commentCount > 0 && ops.openComments && <button className="block-comment-count" aria-label={`${commentCount} block comments`} onClick={(event) => ops.openComments?.(block.id, event.currentTarget)}>💬 {commentCount}</button>}
    <BlockConflictNotice pageId={ops.pageId} blockId={block.id} />
  </div>;
}
export default memo(BlockItem, (prev, next) => prev.block === next.block && prev.ops.locked === next.ops.locked && prev.spellCheck === next.spellCheck && prev.ordinal === next.ordinal && prev.selected === next.selected && prev.commentCount === next.commentCount && (prev.ops.draggingId === prev.block.id) === (next.ops.draggingId === next.block.id) && (prev.ops.dropTarget?.id === prev.block.id ? prev.ops.dropTarget.position : null) === (next.ops.dropTarget?.id === next.block.id ? next.ops.dropTarget.position : null) && (!["button", "page", "toc", "breadcrumb", "database"].includes(next.block.type) || prev.pages === next.pages));
