import { Input } from "@/components/FormControls";
import { useRef, useState } from "react";
import type { Block } from "@/lib/types";
import type { BlockOps } from "@/lib/blockOps";
import { safeHref } from "@/lib/utils";
import { EMBED_PROVIDERS, toEmbedSrc, toIframeEmbed } from "@/lib/embed";
import { putFile, useFileUrl } from "@/lib/fileStore";
import { newId } from "@/lib/factories";
const LABELS: Record<string, [string, string]> = {
  image: ["Add an image", "Paste an image URL…"], video: ["Embed a video", "Paste a YouTube / Vimeo / .mp4 URL…"],
  audio: ["Embed an audio clip", "Paste an audio URL (.mp3, .wav…)…"], file: ["Add a file", "Paste a file URL to link…"], embed: ["Add an embed", "Paste any link to embed…"],
};
function formatBytes(n?: number): string {
  if (n === undefined || n === null) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 ? 0 : 1) + " " + units[i];
}
export default function MediaBlock({ block, ops }: { block: Block; ops: BlockOps }) {
  const [error, setError] = useState(""), [url, setUrl] = useState(""), [width, setWidth] = useState<number | null>(null), figure = useRef<HTMLElement>(null);
  const resize = useRef<{ x: number; width: number; total: number; edge: number } | null>(null), liveWidth = useRef<number | null>(null);
  const provider = block.embedProvider ? EMBED_PROVIDERS[block.embedProvider] : null;
  const [label, placeholder] = provider ? [`Embed ${provider.label}`, provider.placeholder] : LABELS[block.type];
  const fileUrl = useFileUrl(block.fileId), src = fileUrl ?? safeHref(block.url), iframe = block.type === "embed" ? toEmbedSrc(block.url ?? "", block.embedProvider) : block.type === "video" ? toIframeEmbed(block.url ?? "") : null;
  const caption = <Input label="Media caption" className="media-caption" aria-label="Media caption" placeholder="Write a caption…" key={block.caption} defaultValue={block.caption ?? ""} readOnly={ops.locked} onBlur={(e) => { if (e.target.value !== block.caption) ops.updateBlock(block.id, { caption: e.target.value }); }} />;
  const finish = () => { if (liveWidth.current !== null) ops.updateBlock(block.id, { width: Math.round(liveWidth.current) }); resize.current = null; liveWidth.current = null; setWidth(null); };
  if (!block.url && !block.fileId) return <form className="media-prompt" onSubmit={(e) => { e.preventDefault(); if (!url.trim()) return; let fileName = url.trim(); try { fileName = decodeURIComponent(new URL(url.trim()).pathname.split("/").pop() || fileName); } catch {} ops.updateBlock(block.id, { url: url.trim(), ...(block.type === "file" ? { fileName } : {}) }); }}><p>{provider?.icon} {label}</p>{block.type !== "embed" && !ops.locked && <div className="action-button mt-2 inline-block cursor-pointer"><Input label="Upload file" labelClassName="cursor-pointer" aria-label="Upload file" type="file" className="sr-only" accept={block.type === "image" ? "image/*" : block.type === "audio" ? "audio/*" : block.type === "video" ? "video/*" : undefined} onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; const id = newId(); try { await putFile(id, file); ops.updateBlock(block.id, { fileId: id, fileName: file.name, fileSize: file.size, url: undefined }); } catch { setError("Could not save this file. Check available storage."); } }} /></div>}{error && <p role="alert" className="danger">{error}</p>}<div className="mt-2 flex gap-2"><Input label={placeholder} className="min-w-0 flex-1" placeholder={placeholder} value={url} onChange={(e) => setUrl(e.target.value)} readOnly={ops.locked} /><button className="action-button" disabled={ops.locked || !url.trim()}>Embed</button></div></form>;
  if (block.type === "embed") return <figure className="my-1">{!iframe ? <div className="empty-block">Only http and https links can be embedded.<p className="break-all text-text-tertiary">{block.url}</p></div> : block.embedProvider === "pdf" ? <embed src={iframe} type="application/pdf" className="h-[600px] w-full rounded-md border border-border" /> : <iframe src={iframe} title={block.caption || provider?.label || "Embed"} allowFullScreen sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation" className="h-[420px] w-full rounded-md border border-border" />}{caption}</figure>;
  if (!src) return <div className="empty-block">This media link is not available.</div>;
  if (block.type === "file") return <a className="bookmark-block" href={src} download target="_blank" rel="noopener noreferrer"><span>📎</span><span className="min-w-0 flex-1 truncate">{block.fileName || block.url}</span><span className="text-xs text-text-tertiary">{formatBytes(block.fileSize)}</span><span>↓</span></a>;
  // Uploaded audio/video may have no caption resource; keep the supplied caption visible.
  // eslint-disable-next-line jsx-a11y/media-has-caption
  if (block.type === "audio") return <figure><audio src={src} controls className="h-12 w-full"></audio>{caption}</figure>;
  // eslint-disable-next-line jsx-a11y/media-has-caption
  if (block.type === "video") return <figure>{iframe ? <div className="relative aspect-video"><iframe src={iframe} title={block.caption || "Video"} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" className="absolute inset-0 h-full w-full rounded-md" /></div> : <video src={src} controls className="aspect-video w-full rounded-md"></video>}{caption}</figure>;
  return <figure ref={figure} className="image-block"><div className={`relative ${block.align === "center" ? "mx-auto" : block.align === "right" ? "ml-auto" : ""}`} style={{ width: `${width ?? block.width ?? 100}%` }}><img src={src} alt={block.caption ?? ""} draggable={false} className="min-h-24 w-full rounded-md" />{!ops.locked && <><div className="image-align">{(["left", "center", "right"] as const).map((align) => <button key={align} aria-label={`Align ${align}`} onClick={() => ops.updateBlock(block.id, { align })}>{align === "left" ? "⇤" : align === "right" ? "⇥" : "↔"}</button>)}</div>{[-1, 1].map((edge) => <div key={edge} className={`image-resizer ${edge < 0 ? "left-1" : "right-1"}`} role="separator" aria-label="Drag to resize image" onPointerDown={(e) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); resize.current = { x: e.clientX, width: block.width ?? 100, total: figure.current?.clientWidth || 1, edge }; }} onPointerMove={(e) => { const start = resize.current; if (!start) return; const next = Math.max(15, Math.min(100, start.width + (e.clientX - start.x) * start.edge * (block.align === "center" ? 2 : 1) / start.total * 100)); liveWidth.current = next; setWidth(next); }} onPointerUp={finish} onPointerCancel={finish} />)}</>}</div>{caption}</figure>;
}
