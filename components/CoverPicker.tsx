import { Input } from "@/components/FormControls";
import { useEffect, useRef, useState } from "react";
import { COVER_GRADIENTS, COVER_IMAGES, TRAMA_COVERS, coverBackground, safeCover } from "@/lib/cover";
export default function CoverPicker({ onSelect, onClose }: { onSelect: (cover: string) => void; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null), [url, setUrl] = useState(""), [error, setError] = useState("");
  useEffect(() => { const close = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node)) onClose(); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, [onClose]);
  const select = (value: string) => { const cover = safeCover(value.trim()); if (!cover) { setError("Use an http, https, or image data URL."); return; } onSelect(cover); onClose(); };
  return <div ref={panel} className="cover-picker menu-panel" onPointerDown={(e) => e.stopPropagation()}>
    <section aria-label="Trama covers">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span>Trama</span>
        <button type="button" className="icon-button" aria-label="Close cover picker" onClick={onClose}>×</button>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        {TRAMA_COVERS.map((cover) => <button
          type="button"
          key={cover.src}
          className="overflow-hidden rounded border border-border text-left hover:bg-bg-hover"
          onClick={() => select(new URL(cover.src, window.location.origin).href)}
        >
          <img src={cover.thumbnail} alt="" className="block aspect-[3/1] w-full object-cover" loading="lazy" decoding="async" />
          <span className="block px-2 py-1.5 text-xs">{cover.name}</span>
        </button>)}
      </div>
    </section>
    <p className="mb-2 text-sm">Gradients</p>
    <div className="mb-3 grid grid-cols-5 gap-1.5">
      {COVER_GRADIENTS.map((cover, i) => <button type="button" key={cover} aria-label={`Gradient ${i + 1}`} className="h-10 rounded" style={{ background: cover }} onClick={() => select(cover)} />)}
    </div>
    <p className="mb-2 text-sm">Images</p>
    <div className="mb-3 grid grid-cols-2 gap-1.5">
      {COVER_IMAGES.map((cover, i) => <button type="button" key={cover} aria-label={`Cover image ${i + 1}`} className="h-16 rounded bg-cover bg-center" style={{ backgroundImage: coverBackground(cover) }} onClick={() => select(cover)} />)}
    </div>
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); select(url); }}>
      <Input label="Paste image URL…" className="min-w-0 flex-1" placeholder="Paste image URL…" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="submit" className="action-button" disabled={!url.trim()}>Set</button>
    </form>
    {error && <p role="alert" className="danger mt-2 text-xs">{error}</p>}
  </div>;
}
