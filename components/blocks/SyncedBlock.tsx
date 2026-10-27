"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "@/lib/store";
import { createBlock } from "@/lib/factories";
import { setCopiedSyncKey } from "@/lib/syncRef";
import type { Block } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import NestedEditor from "@/components/blocks/NestedEditor";
import { useResolvedSyncedBlocks } from "@/lib/readOnlyData";
const Ancestors = createContext<string[]>([]);
export default function SyncedBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const key = block.syncedFrom ?? block.id, blocks = useResolvedSyncedBlocks(key), parents = useContext(Ancestors);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!blocks && !ops.locked) useStore.getState().setSyncedBlocks(key, [createBlock()]); }, [key, blocks, ops.locked]);
  if (parents.includes(key)) return <p className="text-sm text-text-tertiary">This synced block contains itself.</p>;
  return <div className={`synced-block ${block.syncedFrom ? "synced-copy" : ""}`} contentEditable={false}><div className="mb-2 flex items-center gap-1.5 text-xs text-text-tertiary"><RefreshCw size={12} />{block.syncedFrom ? "Synced (copy)" : "Synced block"}{!ops.locked && <button className="ml-auto" title="Copy this synced block so you can paste it on another page (/synced copy)" onClick={() => { setCopiedSyncKey(key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied!" : "Copy"}</button>}</div><Ancestors.Provider value={[...parents, key]}><NestedEditor pageId={ops.pageId} blocks={blocks ?? []} locked={ops.locked} onChange={(next) => useStore.getState().setSyncedBlocks(key, next)} /></Ancestors.Provider></div>;
}
