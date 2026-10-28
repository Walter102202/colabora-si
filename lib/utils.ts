import clsx, { type ClassValue } from "clsx";

const SAFE_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/** Devuelve el href aceptable o undefined si no debe renderizarse. Las URL sin
 *  esquema (relativas) pasan. El esquema se detecta tras quitar controles y
 *  espacios, porque el navegador los ignora ("java\nscript:" navega igual). */
export function safeHref(raw: string | null | undefined): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) return undefined;
  const probe = value.replace(/[\u0000- \u007F- ]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (!scheme) return value;
  return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase()) ? value : undefined;
}

const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "CODE", "A", "SPAN", "BR", "MARK", "SUP", "SUB"]);
const ALLOWED_CLASS_PREFIXES = ["tc-", "bc-", "math-"];
const ALLOWED_CLASSES = new Set(["mention", "date-mention", "inline-eq", "math-render", "person-mention"]);

export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html; // Pure Node consumers have no DOM.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild as HTMLElement | null;
  if (!root) return "";

  // Recorre la cadena VIVA de hermanos: al desenvolver un elemento sus hijos
  // ascienden a esta lista y deben examinarse a su vez.
  const walk = (node: Node) => {
    let child = node.firstChild;
    while (child) {
      if (child.nodeType === Node.TEXT_NODE) { child = child.nextSibling; continue; }
      if (child.nodeType !== Node.ELEMENT_NODE) {           // comentarios, etc.
        const next = child.nextSibling; child.remove(); child = next; continue;
      }
      const el = child as HTMLElement;
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG"].includes(el.tagName)) {
        const next = el.nextSibling;
        el.remove(); child = next; continue;
      }
      if (!ALLOWED_TAGS.has(el.tagName)) {
        // desenvolver: el elemento se sustituye por sus hijos y se sigue por el primero ascendido
        const parent = el.parentNode!;
        const promoted = el.firstChild;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        const next = el.nextSibling;
        parent.removeChild(el);
        child = promoted ?? next;
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (el.tagName === "A" && name === "href") {
          const safe = safeHref(attr.value);
          if (safe === undefined) el.removeAttribute(name);
          else if (safe !== attr.value) el.setAttribute(name, safe);   // recorte de espacios
          continue;
        }
        if (name === "class") {
          const kept = attr.value.split(/\s+/).filter((c) => ALLOWED_CLASS_PREFIXES.some((p) => c.startsWith(p)) || ALLOWED_CLASSES.has(c));
          if (kept.length) el.setAttribute("class", kept.join(" ")); else el.removeAttribute("class");
          continue;
        }
        if (el.tagName === "A" && name === "data-page") continue;                                  // marcador de mención de página
        if (el.tagName === "SPAN" && el.classList.contains("inline-eq") && name === "data-eq") continue;  // LaTeX del chip
        if (el.tagName === "SPAN" && el.classList.contains("date-mention") && name === "data-date" && /^\d{4}-\d{2}-\d{2}$/.test(attr.value)) continue;
        if (el.tagName === "SPAN" && el.classList.contains("person-mention") && name === "data-user" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attr.value)) continue;
        if (name === "contenteditable" && attr.value === "false") continue;
        el.removeAttribute(attr.name);                      // style, on*, data-*, id, title, target, rel…
      }
      if (el.tagName === "A") {
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("target", "_blank");
      }
      walk(el);
      child = el.nextSibling;
    }
  };
  walk(root);
  return root.innerHTML;
}

/** Texto plano de un HTML (títulos, búsqueda, previsualizaciones). */
export function stripHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]*>/g, "");
  return new DOMParser().parseFromString(html, "text/html").body.textContent || "";
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("en-US", { timeZone: "UTC",
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export const TEXT_COLORS = [
  { key: "default", label: "Default", cls: "" },
  { key: "gray", label: "Gray", cls: "tc-gray" },
  { key: "brown", label: "Brown", cls: "tc-brown" },
  { key: "orange", label: "Orange", cls: "tc-orange" },
  { key: "yellow", label: "Yellow", cls: "tc-yellow" },
  { key: "green", label: "Green", cls: "tc-green" },
  { key: "blue", label: "Blue", cls: "tc-blue" },
  { key: "purple", label: "Purple", cls: "tc-purple" },
  { key: "pink", label: "Pink", cls: "tc-pink" },
  { key: "red", label: "Red", cls: "tc-red" },
];
export const BG_COLORS = [
  { key: "bg-gray", label: "Gray background", cls: "bc-gray" },
  { key: "bg-brown", label: "Brown background", cls: "bc-brown" },
  { key: "bg-orange", label: "Orange background", cls: "bc-orange" },
  { key: "bg-yellow", label: "Yellow background", cls: "bc-yellow" },
  { key: "bg-green", label: "Green background", cls: "bc-green" },
  { key: "bg-blue", label: "Blue background", cls: "bc-blue" },
  { key: "bg-purple", label: "Purple background", cls: "bc-purple" },
  { key: "bg-pink", label: "Pink background", cls: "bc-pink" },
  { key: "bg-red", label: "Red background", cls: "bc-red" },
];
export function blockColorClass(color?: string): string {
  if (!color || color === "default") return "";
  if (color.startsWith("bg-")) return "bc-" + color.slice(3);
  return "tc-" + color;
}

export function cn(...inputs: ClassValue[]): string { return clsx(inputs); }
