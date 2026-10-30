import assert from 'node:assert/strict';
import { extractPdfText } from './pdfText.ts';
import { deflate, pdfFixture, pdfStream, textPdf } from './pdfFixtures.ts';
const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test('extracts text page by page', async () => {
  const result = await extractPdfText(textPdf(['BT /F1 12 Tf (Hello) Tj ET', 'BT /F1 12 Tf [(Second) -300 (page)] TJ ET']));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pages, [{ page: 1, text: 'Hello' }, { page: 2, text: 'Second page' }]);
});
Deno.test('inflates FlateDecode streams', async () => {
  const stream = pdfStream(await deflate(bytes('BT /F1 12 Tf (Compressed) Tj ET')), '/Filter /FlateDecode');
  assert.equal((await extractPdfText(textPdf([stream]))).pages[0].text, 'Compressed');
});
Deno.test('reads objects inside object streams', async () => {
  const bodies = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const header = `2 0 3 ${bodies[0].length + 1} 4 ${bodies[0].length + bodies[1].length + 2} `;
  const pdf = pdfFixture({ 1: '<< /Type /Catalog /Pages 2 0 R >>', 5: pdfStream('BT /F1 12 Tf (Object stream) Tj ET'),
    6: pdfStream(await deflate(bytes(header + bodies.join(' '))), `/Type /ObjStm /N 3 /First ${header.length} /Filter /FlateDecode`),
    7: pdfStream(new Uint8Array(), '/Type /XRef /W [1 2 1] /Size 8') });
  assert.equal((await extractPdfText(pdf)).pages[0].text, 'Object stream');
});
Deno.test('maps glyphs through a ToUnicode CMap', async () => {
  const cmap = '1 beginbfchar <0001> <00E1> endbfchar 1 beginbfrange <0002> <0003> <00E9> endbfrange';
  const pdf = textPdf(['BT /F1 12 Tf <000100020003> Tj ET'], { 3: '<< /Type /Font /Subtype /Type0 /ToUnicode 20 0 R >>', 20: pdfStream(cmap) });
  assert.equal((await extractPdfText(pdf)).pages[0].text, 'áéê');
});
Deno.test('keeps line breaks from Td, TD, T* and ET', async () => {
  const pdf = textPdf(['BT (A) Tj 0 -12 Td (B) Tj 0 -12 TD (C) Tj T* (D) Tj ET BT (E) Tj (F) \' 0 0 (G) " ET']);
  assert.equal((await extractPdfText(pdf)).pages[0].text, 'A\nB\nC\nD\nE\nF\nG');
});
Deno.test('an image-only page has no text', async () => {
  assert.equal((await extractPdfText(textPdf(['q 100 0 0 100 0 0 cm /Image Do Q']))).status, 'empty');
});
Deno.test('flags an encrypted file', async () => {
  assert.equal((await extractPdfText(textPdf([''], {}, '/Encrypt 40 0 R'))).status, 'encrypted');
});
Deno.test('a corrupt file never throws', async () => {
  assert.equal((await extractPdfText(bytes('not a PDF'))).status, 'failed');
});
Deno.test('a decompression bomb stops at the cap', async () => {
  const stream = pdfStream(await deflate(new Uint8Array(20 * 1024 * 1024 + 1).fill(32)), '/Filter /FlateDecode');
  assert.equal((await extractPdfText(textPdf([stream]))).status, 'failed');
});
Deno.test('stops at maxPages', async () => {
  const result = await extractPdfText(textPdf(['BT (First) Tj ET', 'BT (Second) Tj ET']), { maxPages: 1 });
  assert.equal(result.totalPages, 2); assert.equal(result.pages.length, 1);
});
Deno.test('stops Unicode expansion before exceeding the text budget', async () => {
  const expansion = '0041'.repeat(4096);
  for (const content of [`<${'01'.repeat(1000)}> Tj`, `[${'<01> '.repeat(1000)}] TJ`]) {
    const pdf = textPdf([`BT /F1 12 Tf ${content} ET`], {
      3: '<< /Type /Font /Subtype /Type0 /ToUnicode 20 0 R >>',
      20: pdfStream(`1 beginbfchar <01> <${expansion}> endbfchar`),
    });
    const original = Map.prototype.get; let expandedGlyphs = 0;
    Map.prototype.get = function(key: unknown) {
      if (key === '01' && this.has('01')) expandedGlyphs++;
      return original.call(this, key);
    };
    try {
      assert.equal((await extractPdfText(pdf)).status, 'failed');
      assert.ok(expandedGlyphs <= Math.floor(2_000_000 / 4096) + 1, 'stop before constructing text beyond the output budget');
    } finally { Map.prototype.get = original; }
  }
});
