"use client";
import { memo, useCallback } from "react";
import { ChevronRight, GripVertical, Plus } from "lucide-react";
import Editable, { type EditableHandle } from "@/components/Editable";
import { AttributionMargin } from "@/components/agents/AttributionMargin";
import type { Block, Page } from "@/lib/types";
import ButtonBlock from "@/components/blocks/ButtonBlock";
import type { BlockOps } from "@/lib/blockOps";
import { blockColorClass } from "@/lib/utils";
import { CODE_LANGUAGES } from "@/lib/blockMeta";
import BlockPresence from "@/components/BlockPresence";
import BlockConflictNotice from "@/components/blocks/BlockConflictNotice";

interface Props { block: Block; ops: BlockOps; ordinal?: number; spellCheck: boolean; selected?: boolean; pages: Record<string, Page>; insertBlocks: (id: string, blocks: Block[]) => void; commentCount?: number }
function BlockItem({ block, ops, ordinal, spellCheck, selected, pages, insertBlocks, commentCount = 0 }: Props) {
  const register = useCallback((handle: EditableHandle | null) => ops.register(block.id, handle), [block.id, ops]);
  const color = blockColorClass(block.color), heading = block.type.startsWith("heading");
  const placeholder = heading ? `Heading ${block.type.at(-1)}` : block.type === "todo" ? "To-do" : ["bulleted", "numbered"].includes(block.type) ? "List" : block.type === "toggle" ? "Toggle" : block.type === "quote" ? "Empty quote" : block.type === "callout" ? "Type something…" : "Type '/' for commands";
  const text = <Editable ref={register} html={block.html} placeholder={placeholder} spellCheck={spellCheck} readOnly={ops.locked} className={`block-text ${heading ? `block-${block.type} always-ph` : ""} ${block.checked ? "line-through text-text-tertiary" : ""} ${color.startsWith("tc-") ? color : ""}`} onInput={(html) => ops.handleInput(block.id, html)} onBlurSave={(html) => ops.saveBlock(block.id, html)} onKeyDown={(event) => ops.handleKeyDown(block.id, event)} onPaste={(event) => ops.handlePaste(block.id, event)} onFocus={() => ops.setActive(block.id)} />;
  let body: React.ReactNode;
  if (block.type === "button") body = <ButtonBlock block={block} ops={ops} pages={pages} onInsert={(blocks) => insertBlocks(block.id, blocks)} />;
  else if (block.type === "divider") body = <div className="py-3"><hr className="border-border" /></div>;
  else if (block.type === "code") body = <div className="code-block"><div className="code-toolbar"><select aria-label="Code language" disabled={ops.locked} value={block.language ?? "plaintext"} onChange={(event) => ops.updateBlock(block.id, { language: event.target.value })}>{CODE_LANGUAGES.map((language) => <option key={language}>{language}</option>)}</select><button onClick={() => void navigator.clipboard.writeText(block.html)}>Copy</button></div><textarea aria-label="Code" spellCheck={false} readOnly={ops.locked} value={block.html} rows={Math.max(3, block.html.split("\n").length)} onFocus={() => ops.setActive(block.id)} onChange={(event) => ops.updateBlock(block.id, { html: event.target.value })} onKeyDown={(event) => { if (event.key === "Tab" && !ops.locked) { event.preventDefault(); const { selectionStart: start, selectionEnd: end, value } = event.currentTarget; ops.updateBlock(block.id, { html: value.slice(0, start) + "  " + value.slice(end) }); requestAnimationFrame(() => event.currentTarget?.setSelectionRange(start + 2, start + 2)); } }} /></div>;
  else if (block.type === "todo") body = <div className="block-line"><input aria-label="Complete task" type="checkbox" checked={!!block.checked} disabled={ops.locked} onChange={() => ops.toggleChecked(block.id)} />{text}</div>;
  else if (block.type === "bulleted" || block.type === "numbered") body = <div className="block-line"><span className="list-marker">{block.type === "bulleted" ? "•" : `${ordinal ?? 1}.`}</span>{text}</div>;
  else if (block.type === "toggle" || (heading && block.toggleable)) body = <div className="block-line"><button className={`toggle-marker ${heading ? `marker-${block.type}` : ""}`} aria-label={block.collapsed ? "Expand block" : "Collapse block"} onClick={() => ops.toggleCollapsed(block.id)}><ChevronRight size={17} className={block.collapsed ? "" : "rotate-90"} /></button>{text}</div>;
  else if (block.type === "quote") body = <div className="quote-block">{text}</div>;
  else if (block.type === "callout") body = <div className={`callout-block ${color || "bc-gray"}`}><span>{block.icon ?? "💡"}</span>{text}</div>;
  else body = text;
  return <div data-block-id={block.id} className={`block-item ${selected ? "selected-block" : ""}`} style={{ marginLeft: block.indent * 26 }} onMouseDownCapture={(event) => ops.onBlockMouseDown(block.id, event)}>
    <AttributionMargin blockId={block.id} attr={block.attr} />
    <BlockPresence blockId={block.id} />
    {block.attr?.by === "agent" && <span className="agent-dot" title="Edited by an agent" />}
    {!ops.locked && <div className="block-gutter" style={{ top: block.type === "heading1" ? 22 : block.type === "heading2" ? 14 : block.type === "heading3" ? 10 : 0 }} contentEditable={false}><button aria-label="Add block below" onClick={() => ops.addBlockBelow(block.id)}><Plus size={15} /></button><button aria-label="Move or open block menu" onClick={(event) => ops.openBlockMenu(block.id, event.currentTarget)}><GripVertical size={15} /></button></div>}
    <div className={color.startsWith("bc-") && block.type !== "callout" ? `${color} rounded px-2` : ""}>{body}</div>
    {commentCount > 0 && ops.openComments && <button className="block-comment-count" aria-label={`${commentCount} block comments`} onClick={(event) => ops.openComments?.(block.id, event.currentTarget)}>💬 {commentCount}</button>}
    <BlockConflictNotice pageId={ops.pageId} blockId={block.id} />
  </div>;
}
export default memo(BlockItem, (prev, next) => prev.block === next.block && prev.ops.locked === next.ops.locked && prev.spellCheck === next.spellCheck && prev.ordinal === next.ordinal && prev.selected === next.selected && prev.commentCount === next.commentCount && (next.block.type !== "button" || prev.pages === next.pages));
