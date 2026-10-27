export type EmbedProvider = "figma" | "maps" | "tweet" | "codepen" | "pdf" | "loom" | "miro";

export interface EmbedProviderMeta { label: string; icon: string; placeholder: string; description: string; keywords: string[]; }

export const EMBED_PROVIDERS: Record<EmbedProvider, EmbedProviderMeta> = {
  figma:   { label: "Figma",       icon: "🎨", placeholder: "Paste a Figma file / prototype link…", description: "Embed a Figma file or prototype.", keywords: ["figma", "design", "prototype", "mockup"] },
  maps:    { label: "Google Maps", icon: "🗺️", placeholder: "Paste a Google Maps link…",            description: "Embed an interactive map.",          keywords: ["maps", "google maps", "map", "location", "place"] },
  tweet:   { label: "Tweet",       icon: "🐦", placeholder: "Paste a Tweet / X post link…",         description: "Embed a post from Twitter / X.",     keywords: ["tweet", "twitter", "x", "post"] },
  codepen: { label: "CodePen",     icon: "🖊️", placeholder: "Paste a CodePen link…",                description: "Embed an interactive CodePen.",      keywords: ["codepen", "pen", "code", "demo", "snippet"] },
  pdf:     { label: "PDF",         icon: "📕", placeholder: "Paste a PDF URL…",                     description: "Embed a PDF for inline viewing.",    keywords: ["pdf", "document", "paper", "acrobat"] },
  loom:    { label: "Loom",        icon: "📹", placeholder: "Paste a Loom recording link…",         description: "Embed a Loom screen recording.",     keywords: ["loom", "recording", "screencast", "video"] },
  miro:    { label: "Miro",        icon: "🧩", placeholder: "Paste a Miro board link…",             description: "Embed a Miro whiteboard.",           keywords: ["miro", "board", "whiteboard", "canvas"] },
};

function parseHttpUrl(raw: string): URL | null {
  try { const u = new URL(raw); return u.protocol === "http:" || u.protocol === "https:" ? u : null; }
  catch { return null; }
}

const DETECTABLE: EmbedProvider[] = ["figma", "maps", "tweet", "codepen", "loom", "miro"];
export function detectEmbedProvider(raw: string): EmbedProvider | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  if (/\.pdf($|[?#])/i.test(u.pathname)) return "pdf";       // extensión al final del path (no "x.pdf/y")
  for (const p of DETECTABLE) if (providerEmbedUrl(p, raw)) return p;
  return null;
}

export function toIframeEmbed(raw: string): string | null {
  const u = parseHttpUrl(raw);
  if (u) {
    const host = u.hostname.replace(/^www\./, "");
    // ?t= o ?start= de YouTube -> ?start=segundos. Formatos: "90", "90s", "1m30s", "1h2m3s".
    const ytStart = () => {
      const t = (u.searchParams.get("t") ?? u.searchParams.get("start"))?.trim();
      if (!t) return "";
      const secs = /^\d+s?$/.test(t)
        ? parseInt(t, 10)
        : (() => {
            const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
            if (!m || !(m[1] || m[2] || m[3])) return 0;
            return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
          })();
      return secs > 0 ? `?start=${secs}` : "";
    };
    if (host === "youtube.com" || host === "m.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/embed/${v}${ytStart()}`;
      const inPath = u.pathname.match(/^\/(?:shorts|live|v)\/([^/?#]+)/);
      if (inPath) return `https://www.youtube.com/embed/${inPath[1]}${ytStart()}`;
      if (u.pathname.startsWith("/embed/")) return raw;
    }
    if (host === "youtu.be") {
      const id = u.pathname.slice(1);
      if (id) return `https://www.youtube.com/embed/${id}${ytStart()}`;
    }
    if (host === "vimeo.com") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      if (id && /^\d+$/.test(id)) return `https://player.vimeo.com/video/${id}`;
    }
    if (host === "player.vimeo.com" || u.pathname.includes("/embed/")) return raw;
  }
  return null;      // archivo directo (.mp4…) u otra URL: reproductor nativo
}

export function toEmbedSrc(raw: string, provider?: EmbedProvider): string | null {
  const passthrough = parseHttpUrl(raw) ? raw : null;
  if (provider) return providerEmbedUrl(provider, raw) ?? passthrough;   // proveedor explícito que no casa: URL cruda http(s)
  const detected = detectEmbedProvider(raw);
  if (detected && detected !== "pdf") {
    const src = providerEmbedUrl(detected, raw);
    if (src) return src;
  }
  return toIframeEmbed(raw) ?? passthrough;      // YouTube/Vimeo normalizados; si no, cualquier http(s) tal cual
}

export function providerEmbedUrl(provider: EmbedProvider, raw: string): string | null {
  const u = parseHttpUrl(raw); if (!u) return null;
  const host = u.hostname.replace(/^www\./, ""), path = u.pathname;
  if (provider === "pdf") return raw;
  if (provider === "figma" && host === "figma.com") {
    if (path.startsWith("/embed")) return raw;
    if (/^\/(file|proto|design|board|slides)\//.test(path)) return "https://www.figma.com/embed?embed_host=share&url=" + encodeURIComponent(raw);
  }
  if (provider === "maps" && /^(maps\.)?google\.(com|[a-z]{2}|(com|co|org|net)\.[a-z]{2})$/.test(host)) {
    if (path.startsWith("/maps/embed")) return raw;
    if (!path.startsWith("/maps")) return null;
    const place = /\/maps\/place\/([^/]+)/.exec(path), coordinates = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(path);
    let query = u.searchParams.get("q");
    try { query ||= place ? decodeURIComponent(place[1]).replace(/\+/g, " ") : coordinates ? `${coordinates[1]},${coordinates[2]}` : null; } catch { return null; }
    return query ? "https://maps.google.com/maps?q=" + encodeURIComponent(query) + "&output=embed" : null;
  }
  if (provider === "tweet" && ["twitter.com", "mobile.twitter.com", "x.com"].includes(host)) {
    const id = /\/status(?:es)?\/(\d+)/.exec(path)?.[1]; if (id) return "https://platform.twitter.com/embed/Tweet.html?id=" + id;
  }
  if (provider === "codepen" && host === "codepen.io") {
    if (path.includes("/embed/")) return raw;
    const match = /^\/([^/]+)\/(?:pen|details|full)\/([^/?#]+)/.exec(path);
    if (match) return `https://codepen.io/${match[1]}/embed/${match[2]}?default-tab=result`;
  }
  if (provider === "loom" && host === "loom.com") {
    const id = /\/(?:share|embed)\/([a-zA-Z0-9]+)/.exec(path)?.[1]; if (id) return "https://www.loom.com/embed/" + id;
  }
  if (provider === "miro" && host === "miro.com") {
    const id = /\/app\/(?:board|live-embed)\/([^/?#]+)/.exec(path)?.[1]; if (id) return "https://miro.com/app/live-embed/" + id + "/";
  }
  return null;
}

