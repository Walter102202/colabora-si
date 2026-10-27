"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { createBlock, newId } from "@/lib/factories";
import { applyType, indentBlock, mergeWithPrevious, numbering, outdentBlock, splitBlock, visibleBlocks, type BlockOps } from "@/lib/blockOps";
import { caretOffset, insertMentionNode, isCaretAtEnd, isCaretAtStart, setCaretAtOffset, splitAtCaret, textBeforeCaret } from "@/lib/caret";
import { filterSlashItems, MARKDOWN_SHORTCUTS, NON_TEXT, type SlashItem } from "@/lib/blockMeta";
import { runShortcut, shortcutFormat } from "@/lib/formatting";
import { htmlToBlocks } from "@/lib/htmlPaste";
import { cloneWithNewIds } from "@/lib/pageMutations";
import { sanitizeHtml, stripHtml } from "@/lib/utils";
import type { Block, BlockType, Page } from "@/lib/types";
import type { EditableHandle } from "@/components/Editable";
import BlockItem from "@/components/blocks/BlockItem";
import BlockMenu from "@/components/blocks/BlockMenu";
import SlashMenu from "@/components/SlashMenu";
import InlineToolbar from "@/components/InlineToolbar";
import BlockCommentsPopover from "@/components/BlockCommentsPopover";
import MentionMenu, { filteredMentions, type MentionItem } from "@/components/MentionMenu";
import DateMentionPopover from "@/components/DateMentionPopover";
import { formatIsoDate } from "@/components/DatePickerCalendar";
import { withViewTransition } from "@/lib/viewTransition";
import { setLocalActiveBlock } from "@/lib/presence";
import { DeletedBlockConflicts } from "@/components/blocks/BlockConflictNotice";
import { blocksToMarkdown } from "@/lib/export";
import { getCopiedSyncKey } from "@/lib/syncRef";
import EmojiMenu from "@/components/EmojiMenu";
import { searchEmoji, type EmojiEntry } from "@/lib/emojiData";
import { putFile } from "@/lib/fileStore";
import { requestNotifyPermission } from "@/lib/push";
import { renderMath } from "@/lib/math";

export default function BlockEditor({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.pages[pageId]), spellCheck = useStore((s) => s.settings?.spellcheck ?? true), actorId = useStore((s) => s.syncUserId ?? "local");
  const pages = useStore((s) => s.pages);
  if (!page) return null;
  return <><EditorSurface key={pageId} pageId={pageId} blocks={page.blocks} pages={pages} locked={page.locked} spellCheck={spellCheck} actorId={actorId} onChange={(blocks) => useStore.getState().setBlocks(pageId, blocks)} /><DeletedBlockConflicts pageId={pageId} blocks={page.blocks} /></>;
}
interface SurfaceProps { pageId: string; blocks: Block[]; onChange: (blocks: Block[]) => void; locked?: boolean; spellCheck?: boolean; actorId?: string; nested?: boolean; pages?: Record<string, Page> }
type SlashState = { id: string; query: string; index: number; rect: DOMRect };
type Focus = { id: string; offset?: number; end?: boolean };
export function EditorSurface({ pageId, blocks, onChange, locked = false, spellCheck = true, actorId = "local", nested = false, pages = {} }: SurfaceProps) {
  const container = useRef<HTMLDivElement>(null), handles = useRef(new Map<string, EditableHandle>()), latest = useRef({ blocks, onChange, locked, actorId, pages });
  const router = useRouter();
  const active = useRef<string | null>(null), pending = useRef<Focus | null>(null), slashRef = useRef<SlashState | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null), [menu, setMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [selection, setSelection] = useState<{ range: Range; rect: DOMRect; link?: boolean } | null>(null);
  const [comments, setComments] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [mention, setMention] = useState<SlashState | null>(null), mentionRef = useRef<SlashState | null>(null);
  const [emoji, setEmoji] = useState<SlashState | null>(null), emojiRef = useRef<SlashState | null>(null);
  const [equationEdit, setEquationEdit] = useState<{ source: string; rect: DOMRect } | null>(null), equationElement = useRef<HTMLElement | null>(null);
  const [datePick, setDatePick] = useState<SlashState | null>(null);
  const [dateChip, setDateChip] = useState<{ iso: string; rect: DOMRect } | null>(null), dateChipElement = useRef<HTMLElement | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]), selected = useRef<string[]>([]), selAnchor = useRef<string | null>(null), selHead = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null), [dropTarget, setDropTarget] = useState<BlockOps["dropTarget"]>(null), dragState = useRef<{ id: string | null; target: BlockOps["dropTarget"] }>({ id: null, target: null });
  const visible = useMemo(() => nested ? blocks : visibleBlocks(blocks), [blocks, nested]), ordinals = useMemo(() => numbering(blocks), [blocks]);
  const selectBlocks = useCallback((ids: string[], anchor: string | null = ids[0] ?? null, head: string | null = ids.at(-1) ?? null) => {
    selected.current = ids; setSelectedIds(ids); selAnchor.current = anchor; selHead.current = head;
    if (ids.length) (document.activeElement as HTMLElement | null)?.blur();
  }, []);
  const selectRange = useCallback((anchor: string, head: string) => {
    const ids = visibleBlocks(latest.current.blocks).map((b) => b.id), a = ids.indexOf(anchor), b = ids.indexOf(head);
    if (a >= 0 && b >= 0) selectBlocks(ids.slice(Math.min(a, b), Math.max(a, b) + 1), anchor, head);
  }, [selectBlocks]);
  useLayoutEffect(() => {
    latest.current = { blocks, onChange, locked, actorId, pages }; slashRef.current = slash; mentionRef.current = mention;
    if (pending.current) {
      const focus = pending.current; pending.current = null;
      const handle = handles.current.get(focus.id);
      if (handle?.el) { handle.focus(focus.end ?? false); if (focus.offset !== undefined) setCaretAtOffset(handle.el, focus.offset); }
    }
  });
  const selectMention = useCallback((item: MentionItem, from?: SlashState) => {
    const state = from ?? mentionRef.current;
    if (!state || latest.current.locked) return;
    if (item.kind === "pickDate") { setDatePick(state); setMention(null); mentionRef.current = null; return; }
    const handle = handles.current.get(state.id);
    if (!handle?.el) return;
    handle.el.focus();
    const node = document.createElement(item.kind === "page" ? "a" : "span");
    if (item.kind === "page") {
      node.className = "mention"; node.setAttribute("href", "/p/" + item.id); node.dataset.page = item.id; node.textContent = (item.icon ? item.icon + " " : "") + item.title;
    } else if (item.kind === "person") {
      node.className = "mention person-mention"; node.dataset.user = item.id; node.contentEditable = "false"; node.textContent = "@" + item.title;
    } else {
      node.className = "date-mention"; node.dataset.date = item.iso; node.contentEditable = "false"; node.textContent = "📅 " + formatIsoDate(item.iso);
    }
    const selection = window.getSelection();
    if (selection?.rangeCount && handle.el.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0), end = caretOffset(handle.el);
      const insertion = range.cloneRange();
      setCaretAtOffset(handle.el, Math.max(0, end - state.query.length - 1));
      const start = selection.getRangeAt(0);
      insertion.setStart(start.startContainer, start.startOffset); insertion.deleteContents(); insertion.insertNode(node);
      const space = document.createTextNode(" "); node.after(space);
      const after = document.createRange(); after.setStartAfter(space); after.collapse(true); selection.removeAllRanges(); selection.addRange(after);
    } else handle.el.append(node, document.createTextNode(" "));
    const html = sanitizeHtml(handle.getHtml());
    latest.current.onChange(latest.current.blocks.map((block) => block.id === state.id ? { ...block, html, attr: { by: "human", id: latest.current.actorId, at: Date.now() } } : block));
    setMention(null); mentionRef.current = null; setDatePick(null);
  }, []);
  const selectEmoji = useCallback((entry: EmojiEntry) => {
    const state = emojiRef.current, handle = state ? handles.current.get(state.id) : undefined;
    if (!state || !handle?.el || latest.current.locked) return;
    const selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range?.startContainer.nodeType === Node.TEXT_NODE && handle.el.contains(range.startContainer)) {
      const node = range.startContainer, text = node.textContent ?? "", offset = range.startOffset, colon = text.slice(0, offset).lastIndexOf(":");
      node.textContent = text.slice(0, Math.max(0, colon)) + entry.char + text.slice(offset);
      const next = document.createRange(); next.setStart(node, Math.max(0, colon) + entry.char.length); next.collapse(true); selection!.removeAllRanges(); selection!.addRange(next);
    } else {
      const text = handle.getText(), colon = text.lastIndexOf(":"); handle.el.textContent = text.slice(0, Math.max(0, colon)) + entry.char + text.slice(colon + 1).replace(/^[a-z0-9_+-]*/i, ""); handle.focus(true);
    }
    const html = sanitizeHtml(handle.getHtml()); latest.current.onChange(latest.current.blocks.map((b) => b.id === state.id ? { ...b, html } : b));
    emojiRef.current = null; setEmoji(null);
  }, []);
  const ops = useMemo<BlockOps & { chooseSlash: (item: SlashItem) => void; convert: (id: string, type: BlockType) => void }>(() => {
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
    const convert = (id: string, type: BlockType, cleanHtml?: string, item?: SlashItem) => {
      if (nested && ["columns", "database"].includes(type)) return;
      const current = list().map((b) => b.id === id && cleanHtml !== undefined ? { ...b, html: cleanHtml } : b);
      const next = applyType(current, id, type), index = next.findIndex((b) => b.id === id);
      if (index < 0) return;
      const patch: Partial<Block> = {};
      if (NON_TEXT.includes(type)) patch.html = cleanHtml === undefined && type === "code" ? next[index].html : "";
      if (type === "page") patch.pageId = useStore.getState().createPage(pageId, { title: "Untitled", icon: "📄" });
      if (type === "database") { patch.pageId = item?.variant === "linked" ? undefined : useStore.getState().createDatabasePage(pageId); if (item?.variant === "linked") patch.linkedViews = []; }
      if (type === "columns") patch.columns = [0, 1].map(() => ({ id: newId(), blocks: [createBlock()] }));
      if (type === "table") { patch.table = [["", "", ""], ["", "", ""]]; patch.tableHeaderRow = true; }
      if (type === "button") { patch.buttonLabel = "New button"; patch.buttonActions = []; }
      if (type === "equation") patch.equation = "";
      if (type === "synced") patch.syncedFrom = item?.variant === "syncedCopy" ? getCopiedSyncKey() ?? undefined : undefined;
      if (type === "embed") { patch.embedProvider = item?.provider; patch.url = undefined; }
      next[index] = { ...next[index], ...patch };
      handles.current.get(id)?.setHtml(next[index]?.html ?? "");
      if (["page", "divider", "toc", "breadcrumb", "button", "database", "table", "equation", "columns", "synced"].includes(type)) {
        const paragraph = createBlock("paragraph", { indent: next[index].indent }); next.splice(index + 1, 0, paragraph); commit(next, type === "page" && !nested ? undefined : { id: paragraph.id });
      } else commit(next, NON_TEXT.includes(type) ? undefined : { id, end: !nested });
      setSlash(null); slashRef.current = null;
    };
    const chooseSlash = (item: SlashItem) => {
      const state = slashRef.current;
      if (!state) return;
      const handle = handles.current.get(state.id), block = list().find((b) => b.id === state.id);
      if (!handle?.el || !block) return;
      const text = handle.getText(), start = text.lastIndexOf("/");
      if (start >= 0) handle.el.textContent = text.slice(0, start) + text.slice(start + 1 + state.query.length);
      convert(state.id, item.type, sanitizeHtml(handle.getHtml()), item);
    };
    const remove = (id: string) => {
      const index = list().findIndex((b) => b.id === id), next = list().filter((b) => b.id !== id);
      if (!next.length) next.push(createBlock());
      commit(next, { id: next[Math.max(0, index - 1)]?.id ?? next[0].id, end: index > 0 });
    };
    const duplicate = (id: string) => { const index = list().findIndex((b) => b.id === id); if (index < 0) return; const copy = cloneWithNewIds([list()[index]])[0], next = [...list()]; next.splice(index + 1, 0, copy); commit(next, { id: copy.id, end: true }); };
    return {
      pageId, locked, numbering: ordinals, draggingId, dropTarget, convert, chooseSlash,
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
        const mentionMatch = /(?:^|[^A-Za-z0-9@])@([^\s@]{0,40})$/.exec(before);
        if (!nested && mentionMatch) {
          const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect() ?? handle.el.getBoundingClientRect();
          const state = { id, query: mentionMatch[1], index: 0, rect: rect.height ? rect : handle.el.getBoundingClientRect() };
          mentionRef.current = state; setMention(state);
        } else { mentionRef.current = null; setMention(null); }
        const emojiMatch = /(?:^|[^A-Za-z0-9]):([a-z0-9_+-]*)$/.exec(before);
        if (!nested && emojiMatch) {
          const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect() ?? handle.el.getBoundingClientRect();
          const state = { id, query: emojiMatch[1], index: 0, rect: rect.height ? rect : handle.el.getBoundingClientRect() }; emojiRef.current = state; setEmoji(state);
        } else { emojiRef.current = null; setEmoji(null); }
        if (block.type === "paragraph" && handle.getText().trim() === "---") convert(id, "divider", "");
      },
      saveBlock: (id, html) => { if (!latest.current.locked && list().find((b) => b.id === id)?.html !== html) update(id, { html }); if (nested) { slashRef.current = null; setSlash(null); } },
      setActive: (id) => { active.current = id; if (!nested) { setLocalActiveBlock(pageId, id); selectBlocks([]); } if (slashRef.current?.id !== id) { slashRef.current = null; setSlash(null); } if (mentionRef.current?.id !== id) { mentionRef.current = null; setMention(null); } if (emojiRef.current?.id !== id) { emojiRef.current = null; setEmoji(null); } },
      toggleChecked: (id) => { const block = list().find((b) => b.id === id); if (block) update(id, { checked: !block.checked }); },
      toggleCollapsed: (id) => {
        const next = list().map((b) => b.id === id ? { ...b, collapsed: !b.collapsed } : b);
        latest.current.onChange(next);
      },
      updateBlock: update,
      openBlockMenu: (id, anchor) => setMenu({ id, rect: anchor.getBoundingClientRect() }),
      openComments: (id, anchor) => setComments({ id, rect: anchor.getBoundingClientRect() }),
      addBlockBelow: add,
      onBlockMouseDown: (id, event) => {
        if (nested || latest.current.locked || (event.target as HTMLElement).closest<HTMLElement>("[data-block-id]")?.dataset.blockId !== id) return;
        if (event.shiftKey) { event.preventDefault(); selectRange(selAnchor.current ?? active.current ?? id, id); } else selectBlocks([]);
      },
      onDragStart: (id) => { dragState.current = { id, target: null }; setDraggingId(id); setDropTarget(null); setSelection(null); },
      onDragOverBlock: (id, event) => {
        if (nested) event.stopPropagation();
        if (!dragState.current.id || dragState.current.id === id) return;
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(), target = { id, position: event.clientY < rect.top + rect.height / 2 ? "above" as const : "below" as const };
        dragState.current.target = target; setDropTarget(target);
      },
      onDrop: () => {
        const { id, target } = dragState.current;
        if (id && target) { const moved = list().find((b) => b.id === id), next = list().filter((b) => b.id !== id), index = next.findIndex((b) => b.id === target.id); if (moved && index >= 0) { next.splice(index + (target.position === "below" ? 1 : 0), 0, moved); commit(next); } }
        dragState.current = { id: null, target: null }; setDraggingId(null); setDropTarget(null);
      },
      handleKeyDown: (id, event) => {
        if (event.nativeEvent.isComposing || latest.current.locked) return;
        const handle = handles.current.get(id), block = list().find((b) => b.id === id);
        if (!handle?.el || !block) return;
        const mod = event.ctrlKey || event.metaKey;
        const emojiState = emojiRef.current;
        if (!nested && emojiState?.id === id && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape", ":"].includes(event.key)) {
          const items = searchEmoji(emojiState.query, 12);
          if (event.key === "Escape") { event.preventDefault(); emojiRef.current = null; setEmoji(null); }
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const count = Math.max(1, items.length), next = { ...emojiState, index: (emojiState.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count }; emojiRef.current = next; setEmoji(next); }
          else if (items[emojiState.index]) { event.preventDefault(); selectEmoji(items[emojiState.index]); }
          return;
        }
        if (!nested && event.key === "$") {
          const match = /\$([^$\s][^$]*)$/.exec(textBeforeCaret(handle.el));
          if (match) { event.preventDefault(); const span = document.createElement("span"); span.className = "inline-eq"; span.dataset.eq = match[1]; span.contentEditable = "false"; span.innerHTML = renderMath(match[1]); insertMentionNode(handle.el, match[0].length - 1, span); update(id, { html: sanitizeHtml(handle.getHtml()) }); return; }
        }
        if (!nested && mod && event.key.toLowerCase() === "a") {
          const selection = window.getSelection();
          if (!handle.getText() || selection?.toString() === handle.getText()) { event.preventDefault(); selectBlocks(visibleBlocks(list()).map((b) => b.id)); return; }
        }
        if (!nested && mod && event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault(); const next = [...list()], index = next.findIndex((b) => b.id === id), target = index + (event.key === "ArrowUp" ? -1 : 1);
          if (target >= 0 && target < next.length) { next.splice(target, 0, next.splice(index, 1)[0]); commit(next, { id, offset: caretOffset(handle.el) }); } return;
        }
        if (!nested && mod && event.key.toLowerCase() === "d") { event.preventDefault(); duplicate(id); return; }
        if (!nested && mod && event.shiftKey && ["Backspace", "Delete"].includes(event.key)) { event.preventDefault(); remove(id); return; }
        const format = shortcutFormat(event);
        if (format) { event.preventDefault(); event.stopPropagation(); runShortcut(format); if (format !== "link") update(id, { html: handle.getHtml() }); return; }
        const mentionState = mentionRef.current;
        if (mentionState?.id === id && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
          event.preventDefault();
          const items = filteredMentions(latest.current.pages, pageId, mentionState.query);
          if (event.key === "Escape") { setMention(null); mentionRef.current = null; }
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            const count = Math.max(1, items.length), next = { ...mentionState, index: (mentionState.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count };
            mentionRef.current = next; setMention(next);
          } else if (items[mentionState.index]) selectMention(items[mentionState.index]);
          return;
        }
        const state = slashRef.current;
        if (state?.id === id && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
          event.preventDefault(); const items = filterSlashItems(state.query, nested);
          if (event.key === "Escape") { slashRef.current = null; setSlash(null); }
          else if (event.key === "ArrowUp" || event.key === "ArrowDown") { const next = { ...state, index: (state.index + (event.key === "ArrowDown" ? 1 : Math.max(1, items.length) - 1)) % Math.max(1, items.length) }; slashRef.current = next; setSlash(next); }
          else if (items[state.index]) chooseSlash(items[state.index]);
          return;
        }
        if (event.key === " " && block.type === "paragraph") {
          const token = textBeforeCaret(handle.el), shortcut = MARKDOWN_SHORTCUTS.find((s) => s.match.test(token));
          if (shortcut && (!nested || !["+", "[ ]", "```"].includes(token))) { event.preventDefault(); handle.el.textContent = handle.getText().slice(token.length); convert(id, shortcut.type, sanitizeHtml(handle.getHtml())); return; }
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
        const back = (nested ? ["ArrowUp"] : ["ArrowUp", "ArrowLeft"]).includes(event.key), forward = (nested ? ["ArrowDown"] : ["ArrowDown", "ArrowRight"]).includes(event.key);
        if ((back && isCaretAtStart(handle.el)) || (forward && isCaretAtEnd(handle.el))) {
          const vis = (nested ? list() : visibleBlocks(list())).filter((b) => handles.current.has(b.id)), index = vis.findIndex((b) => b.id === id), target = vis[index + (back ? -1 : 1)];
          if (target) { event.preventDefault(); handles.current.get(target.id)?.focus(back); }
        }
        if (!nested && event.key === "Escape") { event.preventDefault(); selectBlocks([id]); setSelection(null); }
      },
      handlePaste: (id, event) => {
        if (latest.current.locked) return;
        const handle = handles.current.get(id), index = list().findIndex((b) => b.id === id), block = list()[index];
        if (!handle?.el || !block) return;
        const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
        if (files.length) {
          event.preventDefault();
          void (async () => {
            const inserted: Block[] = [];
            for (const file of files) { const fileId = newId(); await putFile(fileId, file); inserted.push(createBlock("image", { fileId, fileName: file.name, fileSize: file.size })); }
            if (latest.current.locked) return;
            const next = [...list()], at = next.findIndex((b) => b.id === id); if (at < 0) return;
            const empty = !stripHtml(next[at].html).trim(); next.splice(at + (empty ? 0 : 1), empty ? 1 : 0, ...inserted, createBlock()); commit(next, { id: next[at + inserted.length].id });
          })().catch(() => window.alert("Could not save the pasted image. Check available storage."));
          return;
        }
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
  }, [pageId, locked, ordinals, nested, selectMention, selectEmoji, selectBlocks, selectRange, draggingId, dropTarget]);
  const deleteSelected = useCallback(() => {
    if (latest.current.locked) return;
    const list = latest.current.blocks, first = list.findIndex((b) => selected.current.includes(b.id));
    const remaining = list.filter((b) => !selected.current.includes(b.id));
    if (!remaining.length) remaining.push(createBlock());
    const previous = list[first - 1], target = previous && remaining.includes(previous) ? previous : remaining[0];
    if (!NON_TEXT.includes(target.type)) pending.current = { id: target.id, end: target === previous };
    latest.current.onChange(remaining); selectBlocks([]);
  }, [selectBlocks]);
  const duplicateSelected = useCallback(() => {
    if (latest.current.locked) return;
    const list = latest.current.blocks, copies = cloneWithNewIds(list.filter((b) => selected.current.includes(b.id))), last = list.findLastIndex((b) => selected.current.includes(b.id));
    const next = [...list]; next.splice(last + 1, 0, ...copies); latest.current.onChange(next); selectBlocks(copies.map((b) => b.id));
  }, [selectBlocks]);
  const copySelected = useCallback((cut: boolean) => {
    const markdown = blocksToMarkdown(latest.current.blocks.filter((b) => selected.current.includes(b.id)), latest.current.pages);
    void navigator.clipboard.writeText(markdown).then(() => { if (cut) deleteSelected(); });
  }, [deleteSelected]);
  useEffect(() => {
    if (nested || !selectedIds.length) return;
    const keydown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (!["escape", "enter", "arrowup", "arrowdown", "backspace", "delete"].includes(key) && !(mod && ["a", "d", "c", "x"].includes(key))) return;
      event.preventDefault(); event.stopPropagation();
      const ids = visibleBlocks(latest.current.blocks).map((b) => b.id), head = selHead.current ?? selected.current.at(-1)!;
      if (key === "escape") selectBlocks([]);
      else if (key === "enter") { selectBlocks([]); handles.current.get(head)?.focus(true); }
      else if (mod && key === "a") selectBlocks(ids);
      else if (mod && key === "c") copySelected(false);
      else if (mod && key === "x" && !latest.current.locked) copySelected(true);
      else if (mod && key === "d") duplicateSelected();
      else if (key === "delete" || key === "backspace") deleteSelected();
      else if (key === "arrowup" || key === "arrowdown") { const next = ids[ids.indexOf(head) + (key === "arrowdown" ? 1 : -1)]; if (next) { if (event.shiftKey) selectRange(selAnchor.current ?? next, next); else selectBlocks([next]); } }
    };
    window.addEventListener("keydown", keydown, true); return () => window.removeEventListener("keydown", keydown, true);
  }, [nested, selectedIds.length, selectBlocks, selectRange, copySelected, deleteSelected, duplicateSelected]);
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
  const changeType = (id: string, type: BlockType) => ops.convert(id, type);
  const selectSlash = (item: SlashItem) => ops.chooseSlash(item);
  const menuBlock = menu ? blocks.find((b) => b.id === menu.id) : undefined;
  return <div ref={container} className={`block-editor ${nested ? "nested-editor" : ""}`} onMouseDown={(event) => { if (!event.shiftKey && selected.current.length) selectBlocks([]); }} onClickCapture={(event) => {
    const target = event.target as HTMLElement, link = target.closest<HTMLAnchorElement>("a.mention[data-page]"), chip = target.closest<HTMLElement>("span.date-mention[data-date]");
    if (link?.dataset.page) { event.preventDefault(); withViewTransition(() => router.push("/p/" + link.dataset.page)); }
    const equation = target.closest<HTMLElement>(".inline-eq[data-eq]");
    if (equation && !locked) { event.preventDefault(); equationElement.current = equation; setEquationEdit({ source: equation.dataset.eq ?? "", rect: equation.getBoundingClientRect() }); }
    if (chip && !locked) { event.preventDefault(); dateChipElement.current = chip; setDateChip({ iso: chip.dataset.date!, rect: chip.getBoundingClientRect() }); }
  }}>
    {visible.map((block) => <BlockItem key={block.id} block={block} ops={ops} selected={selectedIds.includes(block.id)} ordinal={ordinals[block.id]} spellCheck={spellCheck} pages={pages} commentCount={pages[pageId]?.comments?.filter((c) => (c.anchorId ?? c.blockId) === block.id && !c.resolved).length ?? 0} insertBlocks={(id, inserted) => {
      const next = [...latest.current.blocks], index = next.findIndex((b) => b.id === id);
      next.splice(index + 1, 0, ...cloneWithNewIds(inserted)); latest.current.blocks = next; latest.current.onChange(next);
    }} />)}
    {!locked && <div className="h-24 cursor-text" aria-label="Add a block" onClick={() => { const last = blocks.at(-1); if (last?.type === "paragraph" && !last.html) handles.current.get(last.id)?.focus(); else if (last) ops.addBlockBelow(last.id); else { const next = createBlock(); pending.current = { id: next.id }; onChange([next]); } }} />}
    {slash && <SlashMenu nested={nested} query={slash.query} index={slash.index} rect={slash.rect} onIndex={(index) => { const next = { ...slash, index }; slashRef.current = next; setSlash(next); }} onSelect={selectSlash} />}
    {emoji && <EmojiMenu query={emoji.query} index={emoji.index} rect={emoji.rect} onSelect={selectEmoji} onIndex={(index) => { const next = { ...emoji, index }; emojiRef.current = next; setEmoji(next); }} />}
    {menu && menuBlock && <BlockMenu block={menuBlock} rect={menu.rect} onClose={() => setMenu(null)} onType={(type) => changeType(menu.id, type)} onUpdate={(patch) => ops.updateBlock(menu.id, patch)} onComment={() => { setComments(menu); setMenu(null); }} onDuplicate={() => { const next = [...blocks], copy = cloneWithNewIds([menuBlock])[0]; next.splice(next.findIndex((b) => b.id === menu.id) + 1, 0, copy); pending.current = { id: copy.id, end: true }; onChange(next); }} onDelete={() => { const next = blocks.filter((b) => b.id !== menu.id); onChange(next.length ? next : [createBlock()]); }} />}
    {selectedIds.length > 1 && <div className="block-selection-toolbar" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}><span>{selectedIds.length} selected</span>{!locked && <button onClick={duplicateSelected}>Duplicate</button>}<button onClick={() => copySelected(false)}>Copy</button>{!locked && <button className="danger" onClick={deleteSelected}>Delete</button>}<button aria-label="Clear selection" onClick={() => selectBlocks([])}>×</button></div>}
    {selection && !slash && !mention && !emoji && <InlineToolbar key={selection.link ? "link" : "format"} range={selection.range} rect={selection.rect} initialLink={selection.link} locked={locked} onClose={() => setSelection(null)} onTurnInto={(type) => { if (active.current) changeType(active.current, type); }} onComment={() => { if (active.current) setComments({ id: active.current, rect: selection.rect }); setSelection(null); }} onChange={() => { for (const [id, handle] of handles.current) if (handle.el?.contains(selection.range.commonAncestorContainer)) ops.saveBlock(id, handle.getHtml()); }} />}
    {comments && <BlockCommentsPopover pageId={pageId} blockId={comments.id} rect={comments.rect} onClose={() => setComments(null)} />}
    {mention && <MentionMenu items={filteredMentions(pages, pageId, mention.query)} index={mention.index} rect={mention.rect} onIndex={(index) => { const next = { ...mention, index }; mentionRef.current = next; setMention(next); }} onSelect={selectMention} />}
    {equationEdit && <><button className="menu-backdrop" aria-label="Close equation editor" onClick={() => setEquationEdit(null)} /><form className="menu-panel fixed z-[70] w-64 p-2" style={{ left: Math.max(8, Math.min(equationEdit.rect.left, innerWidth - 264)), top: Math.min(equationEdit.rect.bottom + 6, innerHeight - 160) }} onSubmit={(event) => { event.preventDefault(); const element = equationElement.current; if (!element) return; element.dataset.eq = equationEdit.source; element.innerHTML = renderMath(equationEdit.source); element.closest('[contenteditable="true"]')?.dispatchEvent(new Event("input", { bubbles: true })); setEquationEdit(null); }}><input autoFocus aria-label="Inline equation" className="cell-input" value={equationEdit.source} onChange={(e) => setEquationEdit({ ...equationEdit, source: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setEquationEdit(null); }} /><div className="math-render p-2" dangerouslySetInnerHTML={{ __html: renderMath(equationEdit.source) }} /><button className="action-button">Save</button></form></>}
    {datePick && <DateMentionPopover rect={datePick.rect} onChangeDate={(iso) => selectMention({ kind: "date", iso, label: "" }, datePick)} onClose={() => setDatePick(null)} />}
    {dateChip && <DateMentionPopover iso={dateChip.iso} rect={dateChip.rect} onClose={() => setDateChip(null)} onChangeDate={(iso) => {
      const element = dateChipElement.current;
      if (!element) return;
      element.dataset.date = iso; element.textContent = "📅 " + formatIsoDate(iso);
      element.closest('[contenteditable="true"]')?.dispatchEvent(new Event("input", { bubbles: true }));
      setDateChip({ ...dateChip, iso });
    }} onRemind={(time) => {
      requestNotifyPermission();
      useStore.getState().addReminder({ date: dateChip.iso + "T" + time, pageId, blockId: dateChipElement.current?.closest<HTMLElement>("[data-block-id]")?.dataset.blockId, text: (dateChipElement.current?.closest('[contenteditable="true"]')?.textContent ?? pages[pageId]?.title ?? "Reminder").slice(0, 120) });
    }} />}
  </div>;
}
