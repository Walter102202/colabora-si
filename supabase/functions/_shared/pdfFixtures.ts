// Small valid PDFs for the parser and tool tests; no binary fixtures or third-party dependencies.
const encode = (value: string) => new TextEncoder().encode(value);
export function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
export function pdfStream(data: Uint8Array | string, dictionary = ''): Uint8Array {
  const bytes = typeof data === 'string' ? encode(data) : data;
  return joinBytes([encode(`<< /Length ${bytes.length} ${dictionary} >>\nstream\n`), bytes, encode('\nendstream')]);
}
export function pdfFixture(objects: Record<number, string | Uint8Array>, trailer = ''): Uint8Array {
  const parts: Uint8Array[] = [encode('%PDF-1.5\n')], offsets = new Map<number, number>();
  let length = parts[0].length;
  for (const [key, value] of Object.entries(objects)) {
    const id = Number(key), body = typeof value === 'string' ? encode(value) : value;
    offsets.set(id, length);
    const part = joinBytes([encode(`${id} 0 obj\n`), body, encode('\nendobj\n')]);
    parts.push(part); length += part.length;
  }
  const size = Math.max(...Object.keys(objects).map(Number)) + 1;
  const xref = ['0000000000 65535 f '];
  for (let i = 1; i < size; i++) xref.push(offsets.has(i) ? `${String(offsets.get(i)).padStart(10, '0')} 00000 n ` : '0000000000 00000 f ');
  parts.push(encode(`xref\n0 ${size}\n${xref.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R ${trailer} >>\nstartxref\n${length}\n%%EOF`));
  return joinBytes(parts);
}
export function textPdf(contents: (string | Uint8Array)[], extra: Record<number, string | Uint8Array> = {}, trailer = ''): Uint8Array {
  const objects: Record<number, string | Uint8Array> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${contents.length} >>`,
    3: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  };
  contents.forEach((content, i) => {
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = typeof content === 'string' ? pdfStream(content) : content;
  });
  return pdfFixture({ ...objects, ...extra }, trailer);
}
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
