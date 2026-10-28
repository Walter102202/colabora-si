import type { Block } from "@/lib/types";
import { stripHtml } from "@/lib/utils";
export default function TocBlock({ blocks }: { blocks: Block[] }) {
  const headings = blocks.filter((b) => /^heading[123]$/.test(b.type));
  return <div className="toc-block" contentEditable={false}>{headings.length ? headings.map((block) => <button key={block.id} style={{ paddingLeft: 4 + (Number(block.type.at(-1)) - 1) * 18 }} onClick={() => document.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" })}>{stripHtml(block.html) || "Untitled"}</button>) : <p className="empty-block">Add headings to populate the table of contents.</p>}</div>;
}
