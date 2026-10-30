import { deflate, pdfFixture, pdfStream, textPdf } from './pdfFixtures.ts';
const enc = (s: string) => new TextEncoder().encode(s);
const M = 1024 * 1024;
async function font(cmap: string | Uint8Array, compress = true) {
  const raw = typeof cmap === 'string' ? enc(cmap) : cmap;
  const stream = compress ? pdfStream(await deflate(raw), '/Filter /FlateDecode') : pdfStream(raw);
  return textPdf(['BT /F1 12 Tf (x) Tj ET'], { 3: '<< /Type /Font /Subtype /Type0 /ToUnicode 20 0 R >>', 20: stream });
}

// Reproductions supplied by the independent P6 review; each runs in an isolated worker.
export const hostilePdfCases: Record<string, () => Promise<Uint8Array>> = {
  async glyph_decode_millions() {
    // Unmapped soft hyphens produce no text, so the output cap cannot bound glyph lookup work.
    const stream = pdfStream(await deflate(enc(`BT /F1 12 Tf <${'ad'.repeat(1_950_000)}> Tj ET`)), '/Filter /FlateDecode');
    return textPdf([stream, stream], {
      3: '<< /Type /Font /ToUnicode 20 0 R >>',
      20: pdfStream('2 beginbfchar <01> <0041> <01020304> <0042> endbfchar'),
    });
  },
  async digits_100k() { return pdfFixture({ 1: '1'.repeat(100_000) + 'x' }); },
  async digits_400k() { return pdfFixture({ 1: '1'.repeat(400_000) + 'x' }); },
  async bfchar_unclosed_1MB() { return font('beginbfchar'.repeat(M / 11)); },
  async bfchar_unclosed_5MB_raw() { return font('beginbfchar'.repeat(450_000), false); },
  async bfrange_noclose_bracket() { return font(`beginbfrange ${'<1><2>['.repeat(300_000)} endbfrange`); },
  async fonts_many_same_cmap() {
    const entries = Array.from({ length: 20_000 }, (_, i) => `/F${i} 3 0 R`).join(' ');
    const cmap = `1 beginbfchar <01> <0041> endbfchar ${' '.repeat(M)}`;
    return pdfFixture({
      1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      3: '<< /Type /Font /ToUnicode 20 0 R >>',
      4: `<< /Type /Page /Parent 2 0 R /Resources << /Font << ${entries} >> >> /Contents 5 0 R >>`,
      5: pdfStream('BT (x) Tj ET'), 20: pdfStream(await deflate(enc(cmap)), '/Filter /FlateDecode'),
    });
  },
  async content_tokens_reuse() {
    // One stream of 490k numbers reused by 200 pages.
    const shared = pdfStream(await deflate(enc('1 '.repeat(490_000))), '/Filter /FlateDecode');
    const kids = Array.from({ length: 200 }, (_, i) => `${100 + i} 0 R`).join(' ');
    const objs: Record<number, string | Uint8Array> = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: `<< /Type /Pages /Kids [${kids}] >>`, 5: shared };
    for (let i = 0; i < 200; i++) objs[100 + i] = '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>';
    return pdfFixture(objs);
  },
  async bomb_19MB_x5() {
    const stream = pdfStream(await deflate(new Uint8Array(19 * M).fill(32)), '/Filter /FlateDecode');
    return textPdf([stream, stream, stream, stream, stream, stream]);
  },
  async objstm_index_huge() {
    const body = ('1 2 '.repeat(4 * M));
    const s = pdfStream(await deflate(enc(body + 'null')), `/Type /ObjStm /N 2 /First ${body.length} /Filter /FlateDecode`);
    return textPdf(['BT (x) Tj ET'], { 30: s });
  },
  async bfrange_repeat_20() { return font(`beginbfrange ${'<0000><FFFF><0041> '.repeat(20)} endbfrange`); },
  async bfrange_repeat_100() { return font(`beginbfrange ${'<0000><FFFF><0041> '.repeat(100)} endbfrange`); },
  async bfrange_repeat_400() { return font(`beginbfrange ${'<0000><FFFF><0041> '.repeat(400)} endbfrange`); },
};
