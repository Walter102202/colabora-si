export const COVER_GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)",
  "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)",
  "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)",
  "linear-gradient(135deg,#30cfd0,#330867)",
  "linear-gradient(135deg,#a8edea,#fed6e3)",
  "linear-gradient(120deg,#e0c3fc,#8ec5fc)",
  "linear-gradient(135deg,#f6d365,#fda085)",
  "linear-gradient(135deg,#5ee7df,#b490ca)",
];

export const COVER_IMAGES = [
  "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=1400&q=80",
  "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=1400&q=80",
  "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1400&q=80",
  "https://images.unsplash.com/photo-1497436072909-60f360e1d4b1?w=1400&q=80",
];

export function safeCover(value: string | null | undefined): string | null {
  if (!value) return null;
  if (COVER_GRADIENTS.includes(value)) return value;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? value : null; } catch { return null; }
}
export function coverBackground(value: string | null | undefined): string | undefined {
  const safe = safeCover(value); return safe ? safe.startsWith("linear-gradient") ? safe : `url(${JSON.stringify(safe)})` : undefined;
}

