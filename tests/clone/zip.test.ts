import { expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { readZip, writeZip, type ZipInput } from "@/lib/zip";
const enc = new TextEncoder(), dec = new TextDecoder();
const input = (name: string, text: string): ZipInput => ({ name, data: enc.encode(text) });
const round = async (entries: ZipInput[]) => readZip(await writeZip(entries).arrayBuffer());
const centralOffset = (buffer: ArrayBuffer) => new DataView(buffer).getUint32(buffer.byteLength - 6, true);
async function deflated(text: string, damage?: "corrupt" | "truncate"): Promise<ArrayBuffer> {
  const plain = enc.encode(text), crc = new DataView(await writeZip([{ name: "a.txt", data: plain }]).arrayBuffer()).getUint32(14, true);
  let compressed = new Uint8Array(deflateRawSync(plain));
  if (damage === "corrupt") compressed[0] = 255;
  if (damage === "truncate") compressed = compressed.slice(0, -5);
  const buffer = await writeZip([{ name: "a.txt", data: compressed }]).arrayBuffer(), view = new DataView(buffer), central = centralOffset(buffer);
  view.setUint16(8, 8, true); view.setUint16(central + 10, 8, true); view.setUint32(22, plain.length, true); view.setUint32(central + 24, plain.length, true);
  view.setUint32(14, crc, true); view.setUint32(central + 16, crc, true); return buffer;
}
it("A-6-223 text round trip", async () => { const [entry] = await round([input("hello.txt", "hello")]); expect(entry.name).toBe("hello.txt"); expect(entry.dir).toBe(false); expect(dec.decode(entry.data)).toBe("hello"); });
it("A-6-224 entry order", async () => { const entries = await round([input("a.txt", "A"), input("b.txt", "B"), input("c.txt", "C")]); expect(entries.map((e) => [e.name, dec.decode(e.data)])).toEqual([["a.txt", "A"], ["b.txt", "B"], ["c.txt", "C"]]); });
it("A-6-225 binary round trip", async () => { const data = Uint8Array.from({ length: 512 }, (_, i) => i * 37 % 256); expect((await round([{ name: "a", data }]))[0].data).toEqual(data); });
it("A-6-226 signature bytes in content", async () => { const data = new Uint8Array([0, 255, 80, 75, 3, 4, 10, 13]); expect((await round([{ name: "a", data }]))[0].data).toEqual(data); });
it("A-6-227 empty file does not shift following data", async () => { const entries = await round([input("empty", ""), input("next", "still here")]); expect(entries[0].data).toHaveLength(0); expect(dec.decode(entries[1].data)).toBe("still here"); });
it("A-6-228 empty archive", async () => expect(await round([])).toEqual([]));
it("A-6-229 UTF-8 paths", async () => { const names = ["café.txt", "日本語/メモ.md", "emoji-🚀.txt", "Ünïcødé.json"]; const entries = await round(names.map((name) => input(name, name))); expect(entries.map((e) => [e.name, dec.decode(e.data)])).toEqual(names.map((name) => [name, name])); });
it("A-6-230 directory and nested file", async () => { const entries = await round([input("pages/", ""), input("pages/deep/note.md", "# Note")]); expect(entries[0].dir).toBe(true); expect(entries[1].dir).toBe(false); expect(dec.decode(entries[1].data)).toBe("# Note"); });
it("A-6-231 content larger than EOCD search window", async () => { const data = new Uint8Array(70000).fill(65); expect((await round([{ name: "large", data }]))[0].data).toEqual(data); });
it("A-6-232 ZIP signatures and entry count", async () => { const buffer = await writeZip([input("a", "A"), input("b", "B")]).arrayBuffer(), view = new DataView(buffer); expect(view.getUint32(0, true)).toBe(0x04034b50); expect(view.getUint32(buffer.byteLength - 22, true)).toBe(0x06054b50); expect(view.getUint16(buffer.byteLength - 12, true)).toBe(2); });
it("A-6-233 stored method and UTF-8 flags", async () => { const view = new DataView(await writeZip([input("a", "A")]).arrayBuffer()); expect(view.getUint16(8, true)).toBe(0); expect(view.getUint16(6, true)).toBe(0x0800); });
it("A-6-234 ZIP MIME", () => expect(writeZip([]).type).toBe("application/zip"));
it("A-6-235 CRC32 vectors and matching headers", async () => {
  for (const [data, expected] of [[enc.encode("123456789"), 0xcbf43926], [enc.encode(""), 0], [enc.encode("hello"), 0x3610a686], [new Uint8Array([0]), 0xd202ef8d]] as const) {
    const buffer = await writeZip([{ name: "a", data }]).arrayBuffer(), view = new DataView(buffer); expect(view.getUint32(14, true)).toBe(expected); expect(view.getUint32(centralOffset(buffer) + 16, true)).toBe(expected);
  }
  const crc = async (text: string) => new DataView(await writeZip([input("a", text)]).arrayBuffer()).getUint32(14, true);
  expect(await crc("hello world")).not.toBe(await crc("hello worle"));
});
it("A-6-236 deflate raw", async () => { const text = "A compressed note with content. ".repeat(25); expect(dec.decode((await readZip(await deflated(text)))[0].data)).toBe(text); });
it("A-6-237 corrupt deflate rejects", async () => expect(readZip(await deflated("A compressed note with content.", "corrupt"))).rejects.toThrow());
it("A-6-238 truncated deflate rejects", async () => expect(readZip(await deflated("A compressed note with content.", "truncate"))).rejects.toThrow());
it("A-6-239 stored CRC is not checked", async () => { const buffer = await writeZip([input("a.txt", "hello")]).arrayBuffer(); new Uint8Array(buffer)[35] = 106; expect(dec.decode((await readZip(buffer))[0].data)).toBe("jello"); });
it("A-6-240 unknown method skipped", async () => { const buffer = await writeZip([input("a", "text")]).arrayBuffer(); new DataView(buffer).setUint16(centralOffset(buffer) + 10, 99, true); expect(await readZip(buffer)).toEqual([]); });
it("A-6-241 unsupported second entry preserves first", async () => { const buffer = await writeZip([input("ok.txt", "fine"), input("bad", "bad")]).arrayBuffer(), view = new DataView(buffer), next = centralOffset(buffer) + 46 + 6; view.setUint16(next + 10, 99, true); const entries = await readZip(buffer); expect(entries.map((e) => e.name)).toEqual(["ok.txt"]); expect(dec.decode(entries[0].data)).toBe("fine"); });
it("A-6-242 missing EOCD", async () => expect(readZip(new ArrayBuffer(100))).rejects.toThrow("end of central directory"));
it("A-6-243 empty input rejected", async () => expect(readZip(new ArrayBuffer(0))).rejects.toThrow());
it("A-6-244 excessive declared count stops at last valid entry", async () => { const buffer = await writeZip([input("a.txt", "a")]).arrayBuffer(); new DataView(buffer).setUint16(buffer.byteLength - 12, 2, true); expect((await readZip(buffer)).map((e) => e.name)).toEqual(["a.txt"]); });
it("A-6-245 corrupt local header skipped", async () => { const buffer = await writeZip([input("a", "text")]).arrayBuffer(); new DataView(buffer).setUint32(0, 0, true); expect(await readZip(buffer)).toEqual([]); });
