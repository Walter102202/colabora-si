import { inflateSync } from 'node:zlib';
// Bounded, iterative text extraction (ISO 32000-1 sections 7.5, 9.4 and 9.10).
// Unsupported content filters produce an empty page; no PDF code or embedded action is executed.
export interface PdfText {
  status: 'ok' | 'empty' | 'encrypted' | 'failed';
  pages: { page: number; text: string }[];
  totalPages: number;
  error?: string;
}
type Atom = { [K in 'name' | 'bytes' | 'word']: { kind: K; value: string } }['name' | 'bytes' | 'word'];
type Value = number | boolean | null | Value[] | Atom
  | { kind: 'ref'; id: number } | { kind: 'dict'; value: Record<string, Value> };
type Token = Value | { kind: 'open' | 'close'; value: 'array' | 'dict' };
interface PdfObject { value: Value; stream?: Uint8Array; decoded?: string | null }
const MAX_STREAM = 20 * 1024 * 1024, MAX_FILE = 100 * 1024 * 1024, MAX_OBJECTS = 10_000;
const MAX_TEXT = 2_000_000, MAX_TOKENS = 2_000_000, MAX_DEPTH = 128;
const MAX_RETAINED = 24 * 1024 * 1024, MAX_WORK = 24_000_000;
interface Work { tokens: number; units: number; mappings: number }
function spend(work: Work, units: number) {
  work.units += units;
  if (work.units > MAX_WORK) throw new Error('PDF work limit exceeded');
}
const space = (c: string) => /[\x00\t\n\f\r ]/.test(c);
const delimiter = (c: string) => !c || space(c) || '()<>[]{}/%'.includes(c);
const tagged = <K extends 'name' | 'bytes' | 'word' | 'ref' | 'dict'>(v: Value | undefined, kind: K): v is Extract<Value, { kind: K }> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && v.kind === kind;
const dictionary = (v: Value | undefined): Record<string, Value> => tagged(v, 'dict') ? v.value : {};
const name = (v: Value | undefined) => tagged(v, 'name') ? v.value : '';
function binary(bytes: Uint8Array): string {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return chunks.join('');
}
function byteArray(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i);
  return out;
}
function hexBytes(value: string): string {
  const hex = value.replace(/\s/g, '');
  if (!/^[\da-f]*$/i.test(hex) || hex.length > MAX_TEXT * 2) throw new Error('Invalid PDF hex string');
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
  return out;
}

function* tokens(source: string, work: Work): Generator<Token> {
  spend(work, source.length);
  let i = 0, inlineImage = false;
  while (i < source.length) {
    const c = source[i];
    if (space(c)) { i++; continue; }
    if (c === '%') { while (i < source.length && !'\r\n'.includes(source[i])) i++; continue; }
    if (++work.tokens > MAX_TOKENS) throw new Error('PDF token limit exceeded');
    if (source.startsWith('<<', i) || source.startsWith('>>', i)) {
      yield { kind: c === '<' ? 'open' : 'close', value: 'dict' }; i += 2; continue;
    }
    if (c === '[' || c === ']') { yield { kind: c === '[' ? 'open' : 'close', value: 'array' }; i++; continue; }
    if (c === '(') {
      i++; let depth = 1, text = '';
      while (i < source.length && depth) {
        let ch = source[i++];
        if (ch === '\\') {
          ch = source[i++];
          if (ch === '\r' || ch === '\n') { if (ch === '\r' && source[i] === '\n') i++; continue; }
          if (/[0-7]/.test(ch ?? '')) {
            let octal = ch;
            while (octal.length < 3 && /[0-7]/.test(source[i] ?? '')) octal += source[i++];
            text += String.fromCharCode(parseInt(octal, 8) & 255);
          } else text += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[ch] ?? ch ?? '';
        } else if (ch === '(') { if (++depth > MAX_DEPTH) throw new Error('PDF nesting limit exceeded'); text += ch; }
        else if (ch === ')') { if (--depth) text += ch; }
        else text += ch;
        if (text.length > MAX_TEXT) throw new Error('PDF string limit exceeded');
      }
      if (depth) throw new Error('Unclosed PDF string');
      yield { kind: 'bytes', value: text }; continue;
    }
    if (c === '<') {
      const end = source.indexOf('>', ++i);
      if (end < 0) throw new Error('Unclosed PDF hex string');
      yield { kind: 'bytes', value: hexBytes(source.slice(i, end)) }; i = end + 1; continue;
    }
    if (c === '/') {
      const start = ++i; while (!delimiter(source[i])) i++;
      yield { kind: 'name', value: source.slice(start, i).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))) }; continue;
    }
    const start = i;
    while (!delimiter(source[i])) i++;
    if (i === start) throw new Error('Unexpected PDF delimiter');
    if (i - start > 64) throw new Error('PDF word limit exceeded');
    const word = source.slice(start, i);
    if (word === 'BI') inlineImage = true;
    if (word === 'ID' && inlineImage) {
      const end = /[\x00\t\n\f\r ]EI(?=[\x00\t\n\f\r ])/g;
      end.lastIndex = i;
      if (!end.exec(source)) throw new Error('Unclosed PDF inline image');
      i = end.lastIndex; inlineImage = false; continue;
    }
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(word)) {
      const number = Number(word), ref = /^\s+\d+\s+R\b/.exec(source.slice(i));
      if (!Number.isFinite(number)) throw new Error('Invalid PDF number');
      if (ref && Number.isInteger(number) && number > 0) { i += ref[0].length; yield { kind: 'ref', id: number }; }
      else yield number;
    } else if (word === 'true' || word === 'false') yield word === 'true';
    else if (word === 'null') yield null;
    else yield { kind: 'word', value: word };
  }
}
function parse(source: string, work: Work, firstOnly = false): Value[] {
  const root: Value[] = [];
  const stack: { type: 'root' | 'array' | 'dict'; values: Value[]; dict: Record<string, Value>; key?: string }[] = [
    { type: 'root', values: root, dict: Object.create(null) },
  ];
  const add = (value: Value) => {
    const frame = stack.at(-1)!;
    if (frame.type !== 'dict') frame.values.push(value);
    else if (frame.key === undefined) {
      if (!tagged(value, 'name')) throw new Error('Invalid PDF dictionary key');
      frame.key = value.value;
    } else { frame.dict[frame.key] = value; frame.key = undefined; }
  };
  for (const token of tokens(source, work)) {
    if (token && typeof token === 'object' && !Array.isArray(token) && (token.kind === 'open' || token.kind === 'close')) {
      if (token.kind === 'open') {
        if (stack.length >= MAX_DEPTH) throw new Error('PDF nesting limit exceeded');
        stack.push({ type: token.value, values: [], dict: Object.create(null) });
      } else {
        const frame = stack.pop();
        if (!stack.length || frame?.type !== token.value || frame.key !== undefined) throw new Error('Invalid PDF container');
        add(frame.type === 'dict' ? { kind: 'dict', value: frame.dict } : frame.values);
      }
    } else add(token as Value);
    if (firstOnly && root.length && stack.length === 1) return root;
  }
  if (stack.length !== 1) throw new Error('Unclosed PDF container');
  return root;
}

function readObjects(bytes: Uint8Array, work: Work) {
  const source = binary(bytes), objects = new Map<number, PdfObject>(), ranges: [number, number][] = [];
  const header = /\b(\d+)\s+\d+\s+obj\b/g;
  let hit: RegExpExecArray | null;
  while ((hit = header.exec(source))) {
    if (ranges.length >= MAX_OBJECTS) throw new Error('PDF object limit exceeded');
    const start = header.lastIndex;
    let end = source.indexOf('endobj', start);
    if (end < 0) throw new Error('Unclosed PDF object');
    const stream = /\bstream(?:\r\n|\n|\r)/.exec(source.slice(start, end));
    const object: PdfObject = { value: parse(source.slice(start, stream ? start + stream.index : end), work, true)[0] ?? null };
    if (stream) {
      const length = dictionary(object.value).Length;
      const dataStart = start + stream.index + stream[0].length;
      const dataEnd = typeof length === 'number' && Number.isInteger(length) && length >= 0 ? dataStart + length : source.indexOf('endstream', dataStart);
      if (dataEnd < dataStart || dataEnd > bytes.length || !/^\s*endstream\b/.test(source.slice(dataEnd, dataEnd + 30))) throw new Error('Invalid PDF stream length');
      object.stream = bytes.subarray(dataStart, dataEnd);
      end = source.indexOf('endobj', dataEnd);
      if (end < 0) throw new Error('Unclosed PDF stream object');
    }
    objects.set(Number(hit[1]), object); ranges.push([hit.index, end + 6]); header.lastIndex = end + 6;
  }
  let root: Value | undefined, encrypted = false, rangeIndex = 0;
  const trailer = /\btrailer\s*(?=<<)/g;
  while ((hit = trailer.exec(source))) {
    while (ranges[rangeIndex]?.[1] <= hit.index) rangeIndex++;
    if (ranges[rangeIndex] && ranges[rangeIndex][0] <= hit.index) continue;
    const dict = dictionary(parse(source.slice(trailer.lastIndex), work, true)[0]);
    root = dict.Root ?? root; encrypted ||= dict.Encrypt !== undefined;
  }
  for (const obj of objects.values()) if (name(dictionary(obj.value).Type) === 'XRef') {
    const dict = dictionary(obj.value); root = dict.Root ?? root; encrypted ||= dict.Encrypt !== undefined;
  }
  return { objects, root, encrypted };
}

function unicode(value: string): string { return new TextDecoder('utf-16be').decode(byteArray(value)); }
function cmap(source: string, work: Work): Map<string, string> {
  spend(work, source.length);
  const result = new Map<string, string>();
  const hex = (value: string) => Array.from(value, c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
  let mappedChars = 0;
  const put = (key: string, value: string) => {
    if (++work.mappings > 100_000 || key.length > 8) throw new Error('PDF character map limit exceeded');
    // Overwritten mappings also consume CPU and allocations.
    if (Math.ceil(value.length / 2) > MAX_TEXT - mappedChars) throw new Error('PDF character map text limit exceeded');
    const text = unicode(value); mappedChars += text.length; result.set(key, text);
  };
  for (const kind of ['bfchar', 'bfrange']) {
    let at = 0;
    while ((at = source.indexOf(`begin${kind}`, at)) !== -1) {
      const start = at + kind.length + 5, end = source.indexOf(`end${kind}`, start);
      if (end < 0) throw new Error('Unclosed PDF character map');
      const values = parse(source.slice(start, end), work); at = end + kind.length + 3;
      const step = kind === 'bfchar' ? 2 : 3;
      for (let i = 0; i < values.length; i += step) {
        const from = values[i], to = values[i + 1], target = values[i + 2];
        if (!tagged(from, 'bytes') || !tagged(to, 'bytes')) throw new Error('Invalid PDF character map');
        const key = hex(from.value);
        if (kind === 'bfchar') { put(key, to.value); continue; }
        const first = parseInt(key, 16), last = parseInt(hex(to.value), 16);
        if (!key.length || key.length > 8 || to.value.length > 4 || last < first || last - first > 65535) throw new Error('Invalid PDF character range');
        const initial = tagged(target, 'bytes') ? hex(target.value) : '';
        if ((!Array.isArray(target) && !initial) || initial.length > 32) throw new Error('Invalid PDF character range');
        for (let code = first; code <= last; code++) {
          const item = Array.isArray(target) ? target[code - first] : undefined;
          const value = Array.isArray(target) ? (tagged(item, 'bytes') ? item.value : null)
            : hexBytes((BigInt(`0x${initial}`) + BigInt(code - first)).toString(16).padStart(initial.length, '0'));
          if (value !== null) put(code.toString(16).padStart(key.length, '0').toUpperCase(), value);
          else spend(work, 1);
        }
      }
    }
  }
  return result;
}
// PDFDocEncoding's non-Latin-1 positions (ISO 32000-1 Annex D.2).
const PDF_DOC_LOW = [...'˘ˇˆ˙˝˛˚˜'], PDF_DOC_HIGH = [...'•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž'];
function fallback(value: string, winAnsi: boolean): string {
  if (value.startsWith('\xfe\xff')) return unicode(value.slice(2));
  if (value.startsWith('\xff\xfe')) return new TextDecoder('utf-16le').decode(byteArray(value.slice(2)));
  if (winAnsi) return new TextDecoder('windows-1252').decode(byteArray(value));
  return [...value].map((c) => {
    const n = c.charCodeAt(0);
    return n >= 24 && n <= 31 ? PDF_DOC_LOW[n - 24] : n >= 128 && n <= 158 ? PDF_DOC_HIGH[n - 128] : n === 160 ? '€' : [127, 159, 173].includes(n) ? '' : c;
  }).join('');
}
interface Font { map: Map<string, string>; widths: number[]; winAnsi: boolean }
function decodeText(value: string, font: Font | undefined, budget: number, work: Work): string {
  // Reserve worst-case hex conversion and lookup work before iterating. Unmapped bytes
  // can advance one byte at a time and produce no text, bypassing the output budget.
  const cost = font?.map.size ? font.widths.reduce((sum, width) => sum + width + 4, 0) : 1;
  spend(work, value.length * cost);
  if (!font?.map.size) {
    const text = fallback(value, font?.winAnsi ?? false);
    if (text.length > budget) throw new Error('PDF text limit exceeded');
    return text;
  }
  let out = '';
  const append = (text: string) => {
    if (text.length > budget - out.length) throw new Error('PDF text limit exceeded');
    out += text;
  };
  for (let i = 0; i < value.length;) {
    let found = false;
    for (const width of font.widths) {
      if (i + width > value.length) continue;
      const key = [...value.slice(i, i + width)].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
      if (font.map.has(key)) { append(font.map.get(key)!); i += width; found = true; break; }
    }
    if (!found) append(fallback(value[i++], font.winAnsi));
  }
  return out;
}
function contentText(source: string, fonts: Map<string, Font>, budget: number, work: Work): string {
  let active = false, font: Font | undefined, out = '', y: number | undefined;
  const operands: Value[] = [];
  const append = (text: string) => {
    if (text.length > budget - out.length) throw new Error('PDF text limit exceeded');
    out += text;
  };
  const line = () => { if (out && !out.endsWith('\n')) append('\n'); };
  const show = (value: Value | undefined) => { if (tagged(value, 'bytes')) append(decodeText(value.value, font, budget - out.length, work)); };
  for (const value of parse(source, work)) {
    if (!tagged(value, 'word')) { operands.push(value); continue; }
    const last = operands.at(-1);
    if (value.value === 'BT') active = true;
    else if (value.value === 'ET') { line(); active = false; }
    else if (value.value === 'Tf') font = fonts.get(name(operands.at(-2)));
    else if (active) {
      switch (value.value) {
        case 'Tj': show(last); break;
        case 'TJ':
          for (const item of Array.isArray(last) ? last : []) {
            if (typeof item === 'number' && item < -100 && out && !/\s$/.test(out)) append(' ');
            else show(item);
          }
          break;
        case "'": case '"': line(); show(last); break;
        case 'Td': case 'TD': if (typeof last === 'number' && last !== 0) line(); break;
        case 'T*': line(); break;
        case 'Tm': if (typeof last === 'number') { if (y !== undefined && y !== last) line(); y = last; } break;
      }
    }
    operands.length = 0;
    if (out.length > MAX_TEXT) throw new Error('PDF text limit exceeded');
  }
  return out.replace(/\x00/g, '').trim();
}

export async function extractPdfText(bytes: Uint8Array, opts: { maxPages?: number } = {}): Promise<PdfText> {
  try {
    if (bytes.length > MAX_FILE || !binary(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('Invalid PDF header or size');
    const work: Work = { tokens: 0, units: 0, mappings: 0 };
    const parsed = readObjects(bytes, work), objects = parsed.objects;
    if (parsed.encrypted) return { status: 'encrypted', pages: [], totalPages: 0 };
    let inflated = 0, retained = 0;
    const resolve = (value: Value | undefined): Value | undefined => {
      const seen = new Set<number>();
      while (tagged(value, 'ref')) {
        if (seen.has(value.id) || seen.size >= MAX_DEPTH) throw new Error('Cyclic PDF reference');
        seen.add(value.id); value = objects.get(value.id)?.value;
      }
      return value;
    };
    const decode = async (obj: PdfObject): Promise<string | null> => {
      if (obj.decoded !== undefined) return obj.decoded;
      if (!obj.stream) return null;
      const rawFilters = resolve(dictionary(obj.value).Filter);
      const filters = rawFilters ? (Array.isArray(rawFilters) ? rawFilters : [rawFilters]).map(name) : [];
      if (filters.some((f) => f !== 'FlateDecode' && f !== 'Fl')) return obj.decoded = null;
      const length = resolve(dictionary(obj.value).Length);
      if (length !== undefined && (!Number.isInteger(length) || Number(length) < 0 || Number(length) > obj.stream.length)) throw new Error('Invalid PDF stream length');
      let data = typeof length === 'number' ? obj.stream.subarray(0, length) : obj.stream;
      for (const _filter of filters) {
        const available = Math.min(MAX_STREAM, MAX_RETAINED - inflated);
        if (available <= 0) throw new Error('PDF decompression limit exceeded');
        // Native bounded inflate accepts a complete zlib member followed by PDF EOL/trailing bytes.
        data = inflateSync(data, { maxOutputLength: available });
        inflated += data.length;
      }
      if (data.length > MAX_STREAM) throw new Error('PDF stream limit exceeded');
      retained += data.length;
      if (retained > MAX_RETAINED) throw new Error('PDF retained stream limit exceeded');
      return obj.decoded = binary(data);
    };
    for (const obj of [...objects.values()]) if (name(dictionary(obj.value).Type) === 'ObjStm') {
      const text = await decode(obj), dict = dictionary(obj.value), count = Number(dict.N), first = Number(dict.First);
      if (text === null || !Number.isInteger(count) || count < 0 || count > MAX_OBJECTS || !Number.isInteger(first) || first < 0 || first > text.length) throw new Error('Invalid PDF object stream');
      if (first > count * 128) throw new Error('PDF object index limit exceeded');
      const index = parse(text.slice(0, first), work).map(v => typeof v === 'number' ? v : NaN);
      if (index.length < count * 2) throw new Error('Invalid PDF object index');
      for (let i = 0; i < count; i++) {
        if (objects.size >= MAX_OBJECTS) throw new Error('PDF object limit exceeded');
        const id = index[i * 2], start = first + index[i * 2 + 1], end = i + 1 < count ? first + index[i * 2 + 3] : text.length;
        if (!Number.isInteger(id) || id <= 0 || start < first || end < start || end > text.length) throw new Error('Invalid compressed PDF object');
        objects.set(id, { value: parse(text.slice(start, end), work, true)[0] ?? null });
      }
    }
    const catalog = resolve(parsed.root) ?? [...objects.values()].find((o) => name(dictionary(o.value).Type) === 'Catalog')?.value;
    const stack: Value[] = [dictionary(catalog).Pages], seen = new Set<Value>(), pages: Record<string, Value>[] = [];
    while (stack.length) {
      const value = resolve(stack.pop()); if (!value || seen.has(value)) continue;
      seen.add(value); const dict = dictionary(value);
      if (name(dict.Type) === 'Page') { pages.push(dict); if (pages.length > 500) throw new Error('PDF page limit exceeded'); }
      else { const kids = resolve(dict.Kids); if (Array.isArray(kids)) stack.push(...[...kids].reverse()); }
      if (seen.size > MAX_OBJECTS) throw new Error('PDF page tree limit exceeded');
    }
    if (!pages.length) throw new Error('PDF has no readable page tree');
    const result: { page: number; text: string }[] = [];
    const maxPages = Math.max(0, Math.min(500, opts.maxPages ?? 500));
    let textSize = 0, consumedContent = 0;
    const fontCache = new Map<Value, Font>(), mapCache = new Map<PdfObject, Map<string, string>>();
    for (const [pageIndex, page] of pages.slice(0, maxPages).entries()) {
      let resources = page.Resources, parent = page.Parent; const parents = new Set<Value>();
      while (!resources && parent) {
        const value = resolve(parent); if (!value || parents.has(value)) break; parents.add(value);
        const dict = dictionary(value); resources = dict.Resources; parent = dict.Parent;
      }
      const fonts = new Map<string, Font>();
      for (const [key, value] of Object.entries(dictionary(resolve(dictionary(resolve(resources)).Font)))) {
        spend(work, 1);
        const resolved = resolve(value);
        if (!resolved) continue;
        let font = fontCache.get(resolved);
        if (!font) {
          const dict = dictionary(resolved), mapObject = tagged(dict.ToUnicode, 'ref') ? objects.get(dict.ToUnicode.id) : undefined;
          let mapping = mapObject ? mapCache.get(mapObject) : undefined;
          if (!mapping) {
            mapping = mapObject ? cmap(await decode(mapObject) ?? '', work) : new Map<string, string>();
            if (mapObject) mapCache.set(mapObject, mapping);
          }
          font = { map: mapping, widths: [...new Set([...mapping.keys()].map(k => k.length / 2))].sort((a, b) => b - a), winAnsi: name(resolve(dict.Encoding)) === 'WinAnsiEncoding' };
          fontCache.set(resolved, font);
        }
        fonts.set(key, font);
      }
      const resolvedContents = resolve(page.Contents);
      const contents = Array.isArray(resolvedContents) ? resolvedContents : [page.Contents];
      const streams: string[] = [];
      for (const ref of contents) {
        const obj = tagged(ref, 'ref') ? objects.get(ref.id) : undefined;
        if (obj) {
          const text = await decode(obj);
          if (text !== null) {
            consumedContent += text.length;
            if (consumedContent > MAX_FILE) throw new Error('PDF content traversal limit exceeded');
            streams.push(text);
          }
        }
      }
      const text = contentText(streams.join('\n'), fonts, MAX_TEXT - textSize, work); textSize += text.length;
      if (textSize > MAX_TEXT) throw new Error('PDF text limit exceeded');
      result.push({ page: pageIndex + 1, text });
    }
    return { status: result.some((p) => p.text.trim()) ? 'ok' : 'empty', pages: result, totalPages: pages.length };
  } catch (error) {
    return { status: 'failed', pages: [], totalPages: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}
