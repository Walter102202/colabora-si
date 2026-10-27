"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { createBlock } from "@/lib/factories";
import { applyType, indentBlock, mergeWithPrevious, numbering, outdentBlock, splitBlock, visibleBlocks, type BlockOps } from "@/lib/blockOps";
import { caretOffset, isCaretAtEnd, isCaretAtStart, setCaretAtOffset, splitAtCaret, textBeforeCaret } from "@/lib/caret";
import { filterSlashItems, MARKDOWN_SHORTCUTS, NON_TEXT, type SlashItem } from "@/lib/blockMeta";
import { runShortcut, shortcutFormat } from "@/lib/formatting";
import { htmlToBlocks } from "@/lib/htmlPaste";
import { cloneWithNewIds } from "@/lib/pageMutations";
import { sanitizeHtml, stripHtml } from "@/lib/utils";
import type { Block, BlockType } from "@/lib/types";
import type { EditableHandle } from "@/components/Editable";
import BlockItem from "@/components/blocks/BlockItem";
import BlockMenu from "@/components/blocks/BlockMenu";
import SlashMenu from "@/components/SlashMenu";
import InlineToolbar from "@/components/InlineToolbar";

export default function BlockEditor({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), actorId = useStore((s) => s.syncUserId ?? "local");
  if (!page) return null;
  return <EditorSurface key={pageId} pageId={pageId} blocks={page.blocks} locked={page.locked} spellCheck={spellCheck} actorId={actorId} onChange={(blocks) => useStore.getState().setBlocks(pageId, blocks)} />;
}
interface SurfaceProps { pageId: string; blocks: Block[]; onChange: (blocks: Block[]) => void; locked?: boolean; spellCheck?: boolean; actorId?: string; nested?: boolean }
type SlashState = { id: string; query: string; index: number; rect: DOMRect };
type Focus = { id: string; offset?: number; end?: boolean };
export function EditorSurface({ pageId, blocks, onChange, locked = false, spellCheck = true, actorId = "local", nested = false }: SurfaceProps) {
  const container = useRef<HTMLDivElement>(null), handles = useRef(new Map<string, EditableHandle>()), latest = useRef({ blocks, onChange, locked, actorId });
  const active = useRef<string | null>(null), pending = useRef<Focus | null>(null), slashRef = useRef<SlashState | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null), [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [selection, setSelection] = useState<{ range: Range; rect: DOMRect; link?: boolean } | null>(null);
  const visible = useMemo(() => nested ? blocks : visibleBlocks(blocks), [blocks, nested]), ordinals = useMemo(() => numbering(blocks), [blocks]);
  useLayoutEffect(() => {
    latest.current = { blocks, onChange, locked, actorId }; slashRef.current = slash;
    if (pending.current) {
      const focus = pending.current; pending.current = null;
      const handle = handles.current.get(focus.id);
      if (handle?.el) { handle.focus(focus.end ?? false); if (focus.offset !== undefined) setCaretAtOffset(handle.el, focus.offset); }
    }
  });
  const ops = useMemo<BlockOps>(() => {
    const list = () => latest.current.blocks;
    const commit = (next: Block[], focus?: Focus) => {
      if (latest.current.locked) return;
      if (focus) pending.current = focus;
      latest.current = { ...latest.current, blocks: next };
      latest.current.onChange(next);
    };
    const update = (id: string, patch: Partial<Block>) => commit(list().map((b) => b.id === id ? { ...b, ...patch, ...(patch.html !== undefined && (patch.type ?? b.type) !== "code" ? { html: sanitizeHtml(patch.html) } : {}), attr: { by: "human", id: latest.current.actorId, at: Date.now() } } : b));
    const add = (id: string) => {
      const index = list().findIndex((b) => b.id === id), next = createBlock("paragraph", { indent: list()[index]?.indent ?? 0 }), blocks = [...list()];
      blocks.splice(index + 1, 0, next); commit(blocks, { id: next.id });
    };
    const convert = (id: string, type: BlockType, cleanHtml?: string) => {
      const current = list().map((b) => b.id === id && cleanHtml !== undefined ? { ...b, html: cleanHtml } : b);
      const next = applyType(current, id, type), index = next.findIndex((b) => b.id === id);
      handles.current.get(id)?.setHtml(next[index]?.html ?? "");
      if (type === "divider") { const paragraph = createBlock("paragraph", { indent: next[index].indent }); next.splice(index + 1, 0, paragraph); commit(next, { id: paragraph.id }); }
      else commit(next, { id, end: !nested });
      setSlash(null); slashRef.current = null;
    };
    const chooseSlash = (item: SlashItem) => {
      const state = slashRef.current;
      if (!state) return;
      const handle = handles.current.get(state.id), block = list().find((b) => b.id === state.id);
      if (!handle?.el || !block) return;
      const offset = caretOffset(handle.el), range = window.getSelection()?.getRangeAt(0).cloneRange();
      if (range) { setCaretAtOffset(handle.el, Math.max(0, offset - state.query.length - 1)); const start = window.getSelection()!.getRangeAt(0); range.setStart(start.startContainer, start.startOffset); range.deleteContents(); }
      convert(state.id, item.type, sanitizeHtml(handle.getHtml()));
    };
    const remove = (id: string) => {
      const index = list().findIndex((b) => b.id === id), next = list().filter((b) => b.id !== id);
      if (!next.length) next.push(createBlock());
      commit(next, { id: next[Math.max(0, index - 1)]?.id ?? next[0].id, end: index > 0 });
    };
    const duplicate = (id: string) => { const index = list().findIndex((b) => b.id === id); if (index < 0) return; const copy = cloneWithNewIds([list()[index]])[0], next = [...list()]; next.splice(index + 1, 0, copy); commit(next, { id: copy.id, end: true }); };
    return {
      pageId, locked, numbering: ordinals, draggingId: null, dropTarget: null,
      register: (id, handle) => { if (handle) handles.current.set(id, handle); else handles.current.delete(id); },
      handleInput: (id, html) => {
        update(id, { html });
        const handle = handles.current.get(id), block = list().find((b) => b.id === id);
        if (!handle?.el || !block) return;
        const before = textBeforeCaret(handle.el), match = /\/([^\s/]*)$/.exec(before);
        if (match) {
          const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect() ?? handle.el.getBoundingClientRect();
          const state = { id, query: match[1], index: 0, rect: rect.height ? rect : handle.el.getBoundingClientRect() };
          slashRef.current = state; setSlash(state);
        } else { slashRef.current = null; setSlash(null); }
        if (block.type === "paragraph" && handle.getText().trim() === "---") convert(id, "divider", "");
      },
      saveBlock: (id, html) => { if (!latest.current.locked) update(id, { html }); },
      setActive: (id) => { active.current = id; if (slashRef.current?.id !== id) { slashRef.current = null; setSlash(null); } },
      toggleChecked: (id) => { const block = list().find((b) => b.id === id); if (block) update(id, { checked: !block.checked }); },
      toggleCollapsed: (id) => {
        const next = list().map((b) => b.id === id ? { ...b, collapsed: !b.collapsed } : b);
        latest.current.onChange(next);
      },
      updateBlock: update,
      openBlockMenu: (id, anchor) => setMenu({ id, rect: anchor.getBoundingClientRect() }),
      addBlockBelow: add, onBlockMouseDown: () => {}, onDragStart: () => {}, onDragOverBlock: () => {}, onDrop: () => {},
      handleKeyDown: (id, event) => {
        if (event.nativeEvent.isComposing || latest.current.locked) return;
        const handle = handles.current.get(id), block = list().find((b) => b.id === id);
        if (!handle?.el || !block) return;
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); const next = [...list()], index = next.findIndex((b) => b.id === id), target = index + (event.key === "ArrowUp" ? -1 : 1);
          if (target >= 0 && target < next.length) { next.splice(target, 0, next.splice(index, 1)[0]); commit(next, { id, offset: caretOffset(handle.el) }); } return;
        }
        if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); duplicate(id); return; }
        if (mod && event.shiftKey && ["Backspace", "Delete"].includes(event.key)) { event.preventDefault(); remove(id); return; }
        const format = shortcutFormat(event);
        if (format) { event.preventDefault(); event.stopPropagation(); runShortcut(format); if (format !== "link") update(id, { html: handle.getHtml() }); return; }
        const state = slashRef.current;
        if (state?.id === id && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
          event.preventDefault(); const items = filterSlashItems(state.query);
          if (event.key === "Escape") { slashRef.current = null; setSlash(null); }
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") { const next = { ...state, index: (state.index + (event.key === "ArrowDown" ? 1 : Math.max(1, items.length) - 1)) % Math.max(1, items.length) }; slashRef.current = next; setSlash(next); }
          else if (items[state.index]) chooseSlash(items[state.index]);
          return;
        }
        if (event.key === " " && block.type === "paragraph") {
          const token = textBeforeCaret(handle.el), shortcut = MARKDOWN_SHORTCUTS.find((s) => s.match.test(token));
          if (shortcut) { event.preventDefault(); handle.el.textContent = handle.getText().slice(token.length); convert(id, shortcut.type, sanitizeHtml(handle.getHtml())); return; }
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.shiftKey) { document.execCommand("insertLineBreak"); update(id, { html: handle.getHtml() }); return; }
          const split = splitAtCaret(handle.el), next = splitBlock(list(), id, split), index = next.findIndex((b) => b.id === id), added = next.length > list().length;
          if (nested && block.type === "toggle" && added) next[index + 1] = { ...next[index + 1], indent: block.indent };
          handle.setHtml(next[index].html); commit(next, { id: added ? next[index + 1].id : id }); return;
        }
        if (event.key === "Backspace" && isCaretAtStart(handle.el)) {
          event.preventDefault(); const index = list().findIndex((b) => b.id === id), previous = list()[index - 1];
          const next = mergeWithPrevious(list(), id), merged = !next.some((b) => b.id === id);
          commit(next, { id: merged ? previous.id : id, offset: merged ? stripHtml(previous.html).length : 0 }); return;
        }
        if (event.key === "Delete" && isCaretAtEnd(handle.el)) {
          const index = list().findIndex((b) => b.id === id), following = list()[index + 1];
          if (following) { event.preventDefault(); const next = list().filter((b) => b.id !== following.id).map((b) => b.id === id && !NON_TEXT.includes(following.type) ? { ...b, html: b.html + following.html } : b); const offset = caretOffset(handle.el); handle.setHtml(next[index].html); commit(next, { id, offset }); } return;
        }
        if (event.key === "Tab") { event.preventDefault(); commit((event.shiftKey ? outdentBlock : indentBlock)(list(), id), { id, offset: caretOffset(handle.el) }); return; }
        const back = ["ArrowUp", "ArrowLeft"].includes(event.key), forward = ["ArrowDown", "ArrowRight"].includes(event.key);
        if ((back && isCaretAtStart(handle.el)) || (forward && isCaretAtEnd(handle.el))) {
          const vis = (nested ? list() : visibleBlocks(list())).filter((b) => handles.current.has(b.id)), index = vis.findIndex((b) => b.id === id), target = vis[index + (back ? -1 : 1)];
          if (target) { event.preventDefault(); handles.current.get(target.id)?.focus(back); }
        }
        if (event.key === "Escape") { event.preventDefault(); handle.el.blur(); setSelection(null); }
      },
      handlePaste: (id, event) => {
        if (latest.current.locked) return;
        const handle = handles.current.get(id), index = list().findIndex((b) => b.id === id), block = list()[index];
        if (!handle?.el || !block) return;
        const html = event.clipboardData.getData("text/html"), text = event.clipboardData.getData("text/plain");
        const parsed = html ? htmlToBlocks(html) : [];
        if (!parsed.length && !text) return;
        event.preventDefault();
        if (parsed.length === 1 && parsed[0].type === "paragraph") { document.execCommand("insertHTML", false, parsed[0].html); update(id, { html: handle.getHtml() }); return; }
        if (!parsed.length && !text.includes("\n")) { document.execCommand("insertText", false, text); update(id, { html: handle.getHtml() }); return; }
        const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const inserted = parsed.length ? parsed : text.replace(/\r\n/g, "\n").split("\n").map((line) => {
          let match;
          if ((match = /^(#{1,3})\s+(.*)$/.exec(line))) return createBlock(`heading${match[1].length}` as BlockType, { html: escape(match[2]) });
          if ((match = /^\s*[-*+]\s+\[([ xX]?)\]\s+(.*)$/.exec(line))) return createBlock("todo", { html: escape(match[2]), checked: match[1].toLowerCase() === "x" });
          if ((match = /^\s*[-*+]\s+(.*)$/.exec(line))) return createBlock("bulleted", { html: escape(match[1]) });
          if ((match = /^\s*\d+\.\s+(.*)$/.exec(line))) return createBlock("numbered", { html: escape(match[1]) });
          if ((match = /^\s*>\s+(.*)$/.exec(line))) return createBlock("quote", { html: escape(match[1]) });
          if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return createBlock("divider");
          return createBlock("paragraph", { html: escape(line) });
        });
        const empty = !handle.getText().trim(), next = [...list()];
        if (!empty && !parsed.length && !nested) { document.execCommand("insertText", false, text.replace(/\r\n/g, "\n").split("\n")[0]); next[index] = { ...block, html: sanitizeHtml(handle.getHtml()) }; inserted.shift(); }
        const placed = inserted.map((b) => ({ ...b, indent: b.indent + block.indent }));
        next.splice(index + (empty ? 0 : 1), empty ? 1 : 0, ...placed);
        commit(next, { id: placed.at(-1)?.id ?? id, end: true });
      },
    };
  }, [pageId, locked, ordinals, nested]);
  useEffect(() => {
    if (nested) return;
    const capture = (link = false) => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed || !container.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) { if (!link && !(document.activeElement instanceof HTMLInputElement)) setSelection(null); return; }
      const range = selection.getRangeAt(0), rect = range.getBoundingClientRect();
      if (rect.width || rect.height) setSelection({ range: range.cloneRange(), rect, link });
    };
    const changed = () => capture(), link = () => capture(true);
    document.addEventListener("selectionchange", changed); window.addEventListener("colabora-link-input", link);
    return () => { document.removeEventListener("selectionchange", changed); window.removeEventListener("colabora-link-input", link); };
  }, [nested]);
  const changeType = (id: string, type: BlockType) => {
    const next = applyType(latest.current.blocks, id, type), index = next.findIndex((b) => b.id === id);
    handles.current.get(id)?.setHtml(next[index]?.html ?? "");
    pending.current = { id, end: true }; latest.current.onChange(next);
  };
  const selectSlash = (item: SlashItem) => {
    if (!slash) return;
    const handle = handles.current.get(slash.id);
    if (handle?.el) {
      const offset = caretOffset(handle.el), selection = window.getSelection(), range = selection?.getRangeAt(0).cloneRange();
      if (range) { setCaretAtOffset(handle.el, Math.max(0, offset - slash.query.length - 1)); const start = selection!.getRangeAt(0); range.setStart(start.startContainer, start.startOffset); range.deleteContents(); }
      const current = latest.current.blocks.map((b) => b.id === slash.id ? { ...b, html: sanitizeHtml(handle.getHtml()) } : b), next = applyType(current, slash.id, item.type);
      handle.setHtml(next.find((b) => b.id === slash.id)?.html ?? "");
      if (item.type === "divider") { const paragraph = createBlock(); next.splice(next.findIndex((b) => b.id === slash.id) + 1, 0, paragraph); pending.current = { id: paragraph.id }; }
      else pending.current = { id: slash.id, end: true };
      latest.current.onChange(next);
    }
    setSlash(null); slashRef.current = null;
  };
  const menuBlock = menu ? blocks.find((b) => b.id === menu.id) : undefined;
  return <div ref={container} className="block-editor">
    {visible.map((block) => <BlockItem key={block.id} block={block} ops={ops} ordinal={ordinals[block.id]} spellCheck={spellCheck} />)}
    {!locked && <div className="h-24 cursor-text" aria-label="Add a block" onClick={() => { const last = blocks.at(-1); if (last?.type === "paragraph" && !last.html) handles.current.get(last.id)?.focus(); else if (last) ops.addBlockBelow(last.id); else { const next = createBlock(); pending.current = { id: next.id }; onChange([next]); } }} />}
    {slash && <SlashMenu query={slash.query} index={slash.index} rect={slash.rect} onIndex={(index) => { const next = { ...slash, index }; slashRef.current = next; setSlash(next); }} onSelect={selectSlash} />}
    {menu && menuBlock && <BlockMenu block={menuBlock} rect={menu.rect} onClose={() => setMenu(null)} onType={(type) => changeType(menu.id, type)} onUpdate={(patch) => ops.updateBlock(menu.id, patch)} onDuplicate={() => { const next = [...blocks], copy = cloneWithNewIds([menuBlock])[0]; next.splice(next.findIndex((b) => b.id === menu.id) + 1, 0, copy); pending.current = { id: copy.id, end: true }; onChange(next); }} onDelete={() => { const next = blocks.filter((b) => b.id !== menu.id); onChange(next.length ? next : [createBlock()]); }} />}
    {selection && !slash && <InlineToolbar key={selection.link ? "link" : "format"} range={selection.range} rect={selection.rect} initialLink={selection.link} locked={locked} onClose={() => setSelection(null)} onTurnInto={(type) => { if (active.current) changeType(active.current, type); }} onChange={() => { for (const [id, handle] of handles.current) if (handle.el?.contains(selection.range.commonAncestorContainer)) ops.saveBlock(id, handle.getHtml()); }} />}
  </div>;
}
