import assert from 'node:assert/strict';
import { hostilePdfCases } from './pdfHostileFixtures.ts';
import { extractPdfText } from './pdfText.ts';
import { deflate, joinBytes, pdfFixture, pdfStream, textPdf } from './pdfFixtures.ts';
const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test('extracts text page by page', async () => {
  const result = await extractPdfText(textPdf(['BT /F1 12 Tf (Hello) Tj ET', 'BT /F1 12 Tf [(Second) -300 (page)] TJ ET']));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pages, [{ page: 1, text: 'Hello' }, { page: 2, text: 'Second page' }]);
});
Deno.test('preserves justified text across 200 pages within the file budget', async () => {
  const stream = pdfStream(await deflate(bytes(`BT /F1 12 Tf [${'(word) -120 '.repeat(1500)}] TJ ET`)), '/Filter /FlateDecode');
  const result = await extractPdfText(textPdf(Array.from({ length: 200 }, () => stream)));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.totalPages, 200);
  assert.equal(result.pages.length, 200);
  const expected = Array.from({ length: 1500 }, () => 'word').join(' ');
  for (const page of result.pages) assert.equal(page.text, expected);
});
Deno.test('preserves 3900 two-byte glyphs per page across 500 pages', async () => {
  const stream = pdfStream(await deflate(bytes(`BT /F1 12 Tf <${'0001'.repeat(3900)}> Tj ET`)), '/Filter /FlateDecode');
  const pdf = textPdf(Array.from({ length: 500 }, () => stream), {
    3: '<< /Type /Font /Subtype /Type0 /ToUnicode 2000 0 R >>',
    2000: pdfStream('1 beginbfchar <0001> <0041> endbfchar'),
  });
  const result = await extractPdfText(pdf);
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.totalPages, 500);
  assert.equal(result.pages.length, 500);
  for (const page of result.pages) assert.equal(page.text, 'A'.repeat(3900));
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

for (const [name, build] of Object.entries(hostilePdfCases)) {
  Deno.test(`bounds review PDF work: ${name}`, async () => {
    const input = new Uint8Array(await build());
    const moduleUrl = new URL('./pdfText.ts', import.meta.url).href;
    const url = URL.createObjectURL(new Blob([`import { extractPdfText } from ${JSON.stringify(moduleUrl)};
      self.onmessage = async ({ data }) => self.postMessage(await extractPdfText(data));`], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    // At 48M work units this case decodes its first glyph-heavy page before the second exceeds the cap.
    const deadlineMs = name === 'glyph_decode_millions' ? 6000 : 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<{ status: string; error?: string }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name}: parser exceeded its ${deadlineMs / 1000} second work deadline`)), deadlineMs);
        worker.onmessage = ({ data }) => resolve(data);
        worker.onerror = event => { event.preventDefault(); reject(new Error(event.message)); };
        worker.postMessage(input, [input.buffer]);
      });
      assert.equal(result.status, name === 'fonts_many_same_cmap' ? 'ok' : 'failed', result.error);
    } finally { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); }
  });
}

for (const eol of ["\n", "\r\n"]) {
  Deno.test(`reads Flate streams with indirect Length and ${JSON.stringify(eol)} before endstream`, async () => {
    const data = await deflate(bytes('BT (Indirect length) Tj ET'));
    const stream = joinBytes([bytes('<< /Length 21 0 R /Filter /FlateDecode >>\nstream\n'), data, bytes(`${eol}endstream`)]);
    const result = await extractPdfText(textPdf([stream], { 21: String(data.length) }));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.pages[0].text, 'Indirect length');
  });
}
Deno.test('accepts trailing bytes after a complete Flate stream', async () => {
  const data = joinBytes([await deflate(bytes('BT (Complete stream) Tj ET')), bytes('\r\nextra')]);
  const result = await extractPdfText(textPdf([pdfStream(data, '/Filter /FlateDecode')]));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.pages[0].text, 'Complete stream');
});
Deno.test('skips inline image bytes before reading subsequent text', async () => {
  const result = await extractPdfText(textPdf(['q BI /W 2 /H 2 /CS /G /BPC 8 ID \x01)(\x02>>}{ EI Q BT (After image) Tj ET']));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.pages[0].text, 'After image');
});
