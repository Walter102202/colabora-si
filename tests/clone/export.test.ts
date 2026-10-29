// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { blocksToMarkdown as md, inlineToMarkdown, pageToMarkdown, pageToHtml, rowsToCsv } from "@/lib/export";
import { markdownToBlocks } from "@/lib/markdown";
import { buildGitExport, exportPath, frontMatter, rewriteInternalLinks, slugify } from "@/lib/gitExport";
import { readZip, writeZip } from "@/lib/zip";
import { b, column, db, page, prop, row, T } from "./fixtures";
import type { Block, BlockType } from "@/lib/types";

const inlineCases: [number, [string, string][]][] = [
  [123, [["<b>x</b>", "**x**"], ["<strong>x</strong>", "**x**"], ["<i>x</i>", "*x*"], ["<em>x</em>", "*x*"], ["<s>x</s>", "~~x~~"], ["<strike>x</strike>", "~~x~~"]]],
  [124, [["<code>x</code>", "`x`"]]], [125, [["<u>x</u>", "<u>x</u>"]]], [126, [["a<br>b", "a\nb"]]],
  [127, [["<strong>a <em>b</em></strong>", "**a *b***"], ["<em><code>x</code></em>", "*`x`*"]]],
  [128, [['<span class="tc-red">red</span>', "red"], ["<mark>hi</mark>", "hi"], ['<span class="bc-blue"><b>x</b></span>', "**x**"]]],
  [129, [["a &amp; b", "a & b"], ["&lt;tag&gt;", "<tag>"], ["a&nbsp;b", "a\u00a0b"]]],
  [130, [["", ""]]], [131, [['<a href="https://a.test">text</a>', "[text](https://a.test)"], ["<a>text</a>", "[text]()"]]],
  [132, [['<a href="/p/abc" class="mention">My page</a>', "[My page](/p/abc)"]]],
  [133, [['<a href="/x"><b>bold</b> link</a>', "[**bold** link](/x)"]]],
  [134, [['<span class="inline-eq" data-eq="x^2">x²</span>', "$x^2$"], ['<span class="inline-eq">x</span>', "$$"], ['<span class="inline-eq" data-eq="\\frac{a}{b}"><b>ignored</b></span>', "$\\frac{a}{b}$"], ['let <span class="inline-eq" data-eq="n">n</span> be', "let $n$ be"]]],
];
it.each(inlineCases)("A-6-%i inline export", (_id, cases) => { for (const [input, output] of cases) expect(inlineToMarkdown(input)).toBe(output); });
const blockCases: [number, Block[], string][] = [
  [135, [b("toggle")], "- text"],
  [136, [b("button", { buttonLabel: "Run" }), b("button", { buttonLabel: "" }), b("button")], "🔘 Run\n🔘 Button\n🔘 Button"],
  [137, [b("synced")], "> 🔄 Synced block"], [138, [b("toc"), b("breadcrumb")], ""],
  [139, [b("image", { url: "https://i.test/a.png", caption: "A cat" }), b("image", { url: "https://i.test/a.png" })], "![A cat](https://i.test/a.png)\n![](https://i.test/a.png)"],
  [140, [b("bookmark", { url: "https://a.test", bookmarkTitle: "A site" }), b("bookmark", { url: "https://a.test" })], "[A site](https://a.test)\n[https://a.test](https://a.test)"],
  [141, [b("video", { url: "u", caption: "Clip" }), b("video", { url: "u" }), b("audio", { url: "u", caption: "Song" }), b("audio", { url: "u" }), b("embed", { url: "u", caption: "Board" }), b("embed", { url: "u" })], "🎬 [Clip](u)\n🎬 [Video](u)\n🎵 [Song](u)\n🎵 [Audio](u)\n🌐 [Board](u)\n🌐 [Embed](u)"],
  [142, [b("file", { url: "u", fileName: "informe.pdf", caption: "c" }), b("file", { url: "u", caption: "c" }), b("file", { url: "u" })], "📎 [informe.pdf](u)\n📎 [c](u)\n📎 [File](u)"],
  [143, [b("paragraph", { html: "a" }), ...(["image", "bookmark", "video", "audio", "file", "embed"] as BlockType[]).map((type) => b(type)), b("paragraph", { html: "c" })], "a\nc"],
  [146, [b("table", { table: [["A", "B"], ["1", "2"], ["3", "4"]] })], "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"],
  [147, [b("table", { table: [["<b>A</b>", "<code>c</code>"]] })], "| **A** | `c` |\n| --- | --- |"],
  [148, [b("table", { table: [["a|b"]] })], "| a\\|b |\n| --- |"], [149, [b("table", { table: [["", "B"]] })], "|   | B |\n| --- | --- |"],
  [150, [b("table", { table: [] }), b("table")], ""],
  [151, [b("equation", { equation: "E = mc^2" }), b("equation")], "$$\nE = mc^2\n$$\n$$\n\n$$"],
  [152, [b("columns", { columns: [column([b("paragraph", { html: "left" })]), column([b("paragraph", { html: "right" })]), column([b("heading1", { html: "Title" }), b("bulleted", { html: "item" })])] })], "left\nright\n## Title\n- item"],
  [153, [b("columns", { columns: [column([b("numbered", { html: "a" }), b("numbered", { html: "b" })]), column([b("numbered", { html: "c" })])] })], "1. a\n2. b\n1. c"],
  [154, [b("columns", { columns: [] })], ""],
  [155, [b("bulleted", { indent: 2 }), b("quote", { indent: 1 }), b("heading1", { indent: 1 }), b("divider", { indent: 1 })], "    - text\n  > text\n  ## text\n  ---"],
  [156, [b("code", { indent: 1, html: "x = 1", language: "py" })], "  ```py\nx = 1\n  ```"],
  [157, [b("code", { html: "raw" })], "```\nraw\n```"],
  [158, [b("heading1"), b("heading2"), b("heading3")], "## text\n### text\n#### text"],
  [159, [b("todo", { checked: true }), b("todo", { checked: false })], "- [x] text\n- [ ] text"],
  [160, [b("quote"), b("callout", { icon: "⚠️" }), b("callout"), b("divider")], "> text\n> ⚠️ text\n> 💡 text\n---"],
  [161, [b("code", { html: "x = 1", language: "py" })], "```py\nx = 1\n```"], [162, [b("bulleted"), b("bulleted", { indent: 1 })], "- text\n  - text"],
];
it.each(blockCases)("A-6-%i block export", (_id, blocks, expected) => expect(md(blocks)).toBe(expected));
it("A-6-144 linked page titles", () => {
  expect(md([b("page", { pageId: "kid" })], { kid: page({ title: "Child" }) })).toBe("- 📄 Child");
  expect(md([b("page", { pageId: "kid" })], { kid: page({ title: "" }) })).toBe("- 📄 Untitled");
  expect(md([b("page", { pageId: "gone" }), b("page")])).toBe("- 📄 Sub-page\n- 📄 Sub-page");
});
it("A-6-145 inline database title", () => {
  expect(md([b("database", { pageId: "d" })], { d: page({ title: "Tasks", database: db([]) }) })).toBe("- 🗃️ Tasks (inline database)");
  expect(md([b("database")])).toBe("");
});
it("A-6-163 numbered list counters", () => {
  for (const [indents, expected] of [
    [[0, 0, 0], "1. x\n2. x\n3. x"], [[0, 1, 1, 0], "1. x\n  1. x\n  2. x\n2. x"],
    [[0, 1, 0, 1], "1. x\n  1. x\n2. x\n  1. x"], [[0, 1, 2, 2, 1], "1. x\n  1. x\n    1. x\n    2. x\n  2. x"],
  ] as [number[], string][]) expect(md(indents.map((indent) => b("numbered", { indent, html: "x" })))).toBe(expected);
  expect(md([b("numbered", { html: "x" }), b("numbered", { html: "x" }), b("paragraph", { html: "break" }), b("numbered", { html: "x" })])).toBe("1. x\n2. x\nbreak\n1. x");
});
it("A-6-164 document round trip preserves supported content", () => {
  const input = "## Heading two\nA **bold** and *italic* paragraph\n- bullet one\n  - nested bullet\n- [x] done\n- [ ] open\n1. one\n2. two\n> a quote\n---\n```js\nx\n```";
  const first = markdownToBlocks(input), output = md(first), second = markdownToBlocks(output);
  expect(first.map((b) => b.type)).toEqual(["heading2", "paragraph", "bulleted", "bulleted", "todo", "todo", "numbered", "numbered", "quote", "divider", "code"]);
  expect(second[0].type).toBe("heading3");
  const fields = (blocks: Block[]) => blocks.map(({ html, indent, checked }) => ({ html, indent, checked }));
  expect(fields(second)).toEqual(fields(first)); expect(md(second).split("\n").slice(1)).toEqual(output.split("\n").slice(1));
});
it("A-6-165 inline round trip", () => { const input = "A **bold** and *italic* and `code` and [link](https://a.test)."; expect(md(markdownToBlocks(input))).toBe(input); });
it("A-6-166 code language round trip", () => expect(markdownToBlocks(md(markdownToBlocks("```c++\nint main() {}\n```")))[0]).toMatchObject({ language: "c++", html: "int main() {}" }));
it("A-6-167 headings shift one level", () => { const next = markdownToBlocks(md([b("heading1")])); expect(next[0].type).toBe("heading2"); expect(markdownToBlocks(md(next))[0].type).toBe("heading3"); });
it("A-6-168 page headings", () => { expect(pageToMarkdown(page({ title: "Doc" })).split("\n")[0]).toBe("# Doc"); expect(pageToMarkdown(page({ title: "Doc", icon: "📘" })).split("\n")[0]).toBe("# 📘 Doc"); expect(pageToMarkdown(page({ title: "" })).split("\n")[0]).toBe("# Untitled"); });
it("A-6-169 page body spacing", () => {
  expect(pageToMarkdown(page({ title: "Doc", blocks: [b("paragraph", { html: "body" })] }))).toBe("# Doc\n\nbody");
  expect(pageToMarkdown(page({ title: "Doc", blocks: [] }))).toBe("# Doc\n\n");
  expect(pageToMarkdown(page({ title: "Doc", blocks: [b("heading1", { html: "Section" }), b("paragraph", { html: "body" })] }))).toBe("# Doc\n\n## Section\nbody");
});
it("A-6-170 database table escapes pipes", () => {
  const database = db([prop({ id: "title", name: "Name" }), prop({ id: "score", name: "Score", type: "number" })], [row({ title: "Row | one", score: 5 })]);
  expect(pageToMarkdown(page({ title: "DB", database }))).toBe("# DB\n\n| Name | Score |\n| --- | --- |\n| Row \\| one | 5 |");
});
it("A-6-171 page links in page exports", () => expect(pageToMarkdown(page({ blocks: [b("page", { pageId: "child" })] }), { child: page({ title: "Child page" }) })).toContain("- 📄 Child page"));
it("A-6-172 empty database omits page blocks", () => expect(pageToMarkdown(page({ title: "DB", blocks: [b()], database: db([prop({ id: "title", name: "Name" })]) }))).toBe("# DB\n\n| Name |\n| --- |"));
it("A-6-173 computed database cells", () => {
  const props = [prop({ id: "title", name: "Name" }), prop({ id: "count", name: "Count", type: "number" }), prop({ name: "Double", type: "formula", formula: 'prop("Count") * 2' })];
  expect(pageToMarkdown(page({ database: db(props, [row({ title: "Row", count: 21 })]) }))).toContain("| Row | 21 | 42 |");
  expect(pageToMarkdown(page({ database: db([props[0], prop({ id: "status", type: "select", options: [{ id: "done", name: "Done", color: "green" }] })], [row({ title: "Row", status: "done" })]) }))).toContain("| Row | Done |");
});


const htmlBody = async (blocks: Block[], pages: Record<string, import("@/lib/types").Page> = {}, synced: Record<string, Block[]> = {}) => new DOMParser().parseFromString(await pageToHtml(page({ blocks }), pages, synced), "text/html").body;
it("A-6-174 complete HTML document", async () => { const out = await pageToHtml(page(), {}); expect(out.startsWith("<!DOCTYPE html>")).toBe(true); expect(out).toContain('<html lang="en">'); expect(out).toContain('<meta charset="utf-8">'); expect(out.endsWith("</html>")).toBe(true); });
it("A-6-175 self contained styles", async () => { const doc = new DOMParser().parseFromString(await pageToHtml(page(), {}), "text/html"); expect(doc.querySelector("style")?.textContent).toContain(".page"); expect(doc.querySelector("link,script")).toBeNull(); });
it("A-6-176 document titles", async () => { for (const title of ["My doc", ""]) { const doc = new DOMParser().parseFromString(await pageToHtml(page({ title }), {}), "text/html"); expect(doc.title).toBe(title || "Untitled"); expect(doc.querySelector("h1")?.textContent).toBe(title || "Untitled"); } });
it("A-6-177 title is escaped", async () => { const out = await pageToHtml(page({ title: "<script>alert(1)</script>" }), {}); expect(out).toContain("&lt;script&gt;"); expect(out).not.toContain("<script>"); });
it("A-6-178 optional page icon", async () => { expect(await pageToHtml(page({ icon: "📘" }), {})).toContain('<div class="icon">📘</div>'); expect(await pageToHtml(page(), {})).not.toContain('<div class="icon">'); });
it("A-6-179 gradient cover", async () => { const out = await pageToHtml(page({ cover: "linear-gradient(90deg,#000,#fff)" }), {}); expect(out).toContain('style="background:linear-gradient(90deg,#000,#fff)"'); });
it("A-6-180 image cover position", async () => expect(await pageToHtml(page({ cover: "https://i.test/c.jpg", coverPosition: 30 }), {})).toContain("background-image:url('https://i.test/c.jpg');background-position-y:30%"));
it("A-6-181 no cover", async () => expect(await pageToHtml(page(), {})).not.toContain('<div class="cover"'));
it("A-6-182 product footer", async () => expect(await pageToHtml(page(), {})).toContain("Exported from colabora.si"));
it("A-6-183 heading levels", async () => { const body = await htmlBody([b("heading1"), b("heading2"), b("heading3")]); expect([...body.querySelectorAll("h2.b,h3.b,h4.b")].map((el) => el.tagName)).toEqual(["H2", "H3", "H4"]); });
it("A-6-184 paragraph markup", async () => expect((await htmlBody([b("paragraph", { html: "a <b>bold</b>" })])).querySelector(".b")?.innerHTML).toBe("a <b>bold</b>"));
it("A-6-185 todo state", async () => { const body = await htmlBody([b("todo"), b("todo", { checked: true })]); expect(body.querySelectorAll(".todo")[0].textContent).toBe("☐text"); expect(body.querySelectorAll(".todo")[1].textContent).toBe("☑text"); expect(body.querySelectorAll(".done")).toHaveLength(1); });
it("A-6-186 lists", async () => { const body = await htmlBody([b("bulleted"), b("numbered")]); expect(body.querySelector("ul.one li")?.textContent).toBe("text"); expect(body.querySelector("ol")?.getAttribute("start")).toBe("1"); });
it("A-6-187 numbered reset", async () => { const body = await htmlBody([b("numbered"), b("numbered"), b("numbered"), b(), b("numbered")]); expect([...body.querySelectorAll("ol")].map((el) => el.start)).toEqual([1, 2, 3, 1]); });
it("A-6-188 nested counters", async () => { const body = await htmlBody([0, 1, 1, 0].map((indent) => b("numbered", { indent }))); expect([...body.querySelectorAll("ol")].map((el) => el.start)).toEqual([1, 1, 2, 2]); expect(body.querySelectorAll("ol")[1].style.marginLeft).toBe("24px"); });
it("A-6-189 toggle", async () => expect((await htmlBody([b("toggle")])).querySelector("details summary")?.textContent).toBe("text"));
it("A-6-190 quote callout divider", async () => { const body = await htmlBody([b("quote"), b("callout", { icon: "⚠️" }), b("callout"), b("divider")]); expect(body.querySelector("blockquote")?.textContent).toBe("text"); expect([...body.querySelectorAll(".callout > span")].map((el) => el.textContent)).toEqual(["⚠️", "💡"]); expect(body.querySelector("hr")).not.toBeNull(); });
it("A-6-191 code escapes HTML", async () => expect((await htmlBody([b("code", { html: "<b>x</b>" })])).querySelector("pre code")?.innerHTML).toBe("&lt;b&gt;x&lt;/b&gt;"));
it("A-6-192 buttons and navigation markers", async () => { const body = await htmlBody([b("button", { buttonLabel: "Go" }), b("button"), b("toc", { html: "TOC marker" }), b("breadcrumb", { html: "Breadcrumb marker" })]); expect(body.textContent).toContain("🔘 Go"); expect(body.textContent).toContain("🔘 Button"); expect(body.textContent).not.toContain("marker"); });
it("A-6-193 block colors", async () => { const body = await htmlBody([b("paragraph", { color: "red" }), b("paragraph", { color: "bg-blue" }), b()]); expect([...body.querySelectorAll(".b")].map((el) => el.className)).toEqual(["b tc-red", "b bc-blue", "b"]); });
it("A-6-194 indentation", async () => { const body = await htmlBody([b("paragraph", { indent: 2 }), b()]); expect([...body.querySelectorAll<HTMLElement>(".b")].map((el) => el.style.marginLeft)).toEqual(["48px", ""]); });
it("A-6-195 image captions", async () => { const body = await htmlBody([b("image", { url: "u", caption: "A cat" }), b("image", { url: "u" })]); expect([...body.querySelectorAll("img")].map((el) => el.alt)).toEqual(["A cat", ""]); expect(body.querySelectorAll("figcaption")).toHaveLength(1); });
it("A-6-196 image dimensions", async () => { const body = await htmlBody([b("image", { url: "u", width: 50, align: "center" })]); expect(body.querySelector("img")?.style.width).toBe("50%"); expect(body.querySelector("figure")?.style.textAlign).toBe("center"); });
it("A-6-197 image attribute injection", async () => { const body = await htmlBody([b("image", { url: 'a"onerror="alert(1)' })]); expect(body.querySelector("img")?.getAttribute("src")).toBe('a"onerror="alert(1)'); expect(body.querySelector("[onerror]")).toBeNull(); });
it("A-6-198 media tags", async () => { const body = await htmlBody([b("video", { url: "u" }), b("audio", { url: "u" }), b("file", { url: "u", fileName: "r.pdf" })]); expect(body.querySelector("video[controls]")?.getAttribute("src")).toBe("u"); expect(body.querySelector("audio[controls]")?.getAttribute("src")).toBe("u"); expect(body.querySelector("a[download]")?.getAttribute("download")).toBe("r.pdf"); });
it("A-6-199 missing media omitted", async () => expect((await htmlBody([b("image"), b("video"), b("audio"), b("file")])).querySelector("figure,a")).toBeNull());
it("A-6-200 bookmarks and embeds", async () => { const body = await htmlBody([b("bookmark", { url: "u", bookmarkTitle: "Title" }), b("bookmark", { url: "u" }), b("embed", { url: "u" })]); expect([...body.querySelectorAll("a.bookmark .t")].map((el) => el.textContent)).toEqual(["Title", "u", "u"]); expect(body.querySelector("iframe")).toBeNull(); });
it("A-6-201 table headers", async () => { const body = await htmlBody([{}, { tableHeaderRow: true }, { tableHeaderCol: true }].map((patch) => b("table", { table: [["A", "B"], ["1", "2"]], ...patch }))); expect([...body.querySelectorAll("table")].map((el) => el.querySelectorAll("th").length)).toEqual([0, 2, 2]); });
it("A-6-202 equation rendering", async () => expect((await htmlBody([b("equation", { equation: "\\frac{a}{b}" })])).querySelector(".math-frac")).not.toBeNull());
it("A-6-203 columns", async () => { const body = await htmlBody([b("columns", { columns: [column([b()], 2), column([b()])] })]); expect([...body.querySelectorAll<HTMLElement>(".cols > div")].map((el) => el.style.flexGrow)).toEqual(["2", "1"]); });
it("A-6-204 synced originals and copies", async () => { const body = await htmlBody([b("synced", { id: "source" }), b("synced", { syncedFrom: "source" })], {}, { source: [b("paragraph", { html: "shared content" })] }); expect(body.querySelectorAll(".b")).toHaveLength(2); expect(body.textContent?.match(/shared content/g)).toHaveLength(2); });
it("A-6-205 absent synced content", async () => expect((await htmlBody([b("synced", { syncedFrom: "missing", html: "marker" })])).textContent).not.toContain("marker"));
it("A-6-206 synced cycle guard", async () => { const body = await htmlBody([b("synced", { id: "s" })], {}, { s: [b("paragraph", { html: "once" }), b("synced", { syncedFrom: "s" })] }); expect(body.textContent?.match(/once/g)).toHaveLength(1); });
it("A-6-207 page links", async () => { const body = await htmlBody([b("page", { pageId: "child" }), b("page", { pageId: "gone" })], { child: page({ title: "Child", icon: "🧒" }) }); expect(body.textContent).toContain("🧒 Child"); expect(body.textContent).toContain("Sub-page"); });
it("A-6-208 inline database", async () => { const body = await htmlBody([b("database", { pageId: "db" }), b("database", { pageId: "gone" })], { db: page({ database: db([prop({ id: "title", name: "Name" })], [row({ title: "Row one" })]) }) }); expect(body.querySelectorAll("table")).toHaveLength(1); expect(body.querySelector("th")?.textContent).toBe("Name"); expect(body.querySelector("td")?.textContent).toBe("Row one"); });
it("A-6-209 root database", async () => { const out = await pageToHtml(page({ blocks: [b("paragraph", { html: "marker" })], database: db([prop({ id: "title", name: "Name" })], [row({ title: "a" }), row({ title: "b" })]) }), {}); expect(out).toContain("<td>a</td>"); expect(out).toContain("<td>b</td>"); expect(out).not.toContain("marker"); });
it("A-6-210 database escaping", async () => { const out = await pageToHtml(page({ database: db([prop({ id: "title", name: "<Name>" })], [row({ title: "<script>x</script>" })]) }), {}); expect(out).toContain("&lt;Name&gt;"); expect(out).toContain("&lt;script&gt;x&lt;/script&gt;"); expect(out).not.toContain("<script>"); });
const csvProps = [prop({ id: "title", name: "Name" }), prop({ id: "note", name: "Note" })];
const csv = (cells: Record<string, unknown>[], properties = csvProps) => { const database = db(properties, cells.map((c) => row(c))); return rowsToCsv(properties, database.rows, database, {}); };
it("A-6-211 csv headers", () => expect(csv([])).toBe("Name,Note"));
it("A-6-212 csv CRLF", () => expect(csv([{ title: "a" }, { title: "b" }], [csvProps[0]])).toBe("Name\r\na\r\nb"));
const csvCases: [number, string, string][] = [[213, "Smith, John", '"Smith, John"'], [214, 'say "hi"', '"say ""hi"""'], [215, "line\nnext\rend", '"line\nnext\rend"'], [217, "plain", "plain"]];
it.each(csvCases)("A-6-%i csv values", (_id, input, expected) => expect(csv([{ title: input }], [csvProps[0]])).toBe("Name\r\n" + expected));
it("A-6-216 csv header escaping", () => expect(csv([], [prop({ name: "Last, First" })])).toBe('"Last, First"'));
it("A-6-218 missing empty null csv fields", () => expect(csv([{}, { note: "" }, { note: null }])).toBe("Name,Note\r\n,\r\n,\r\n,"));
it("A-6-219 empty rows", () => expect(csv([])).toBe("Name,Note"));
it("A-6-220 property subset order", () => expect(csv([{ title: "a", note: "b" }], [csvProps[1], csvProps[0]])).toBe("Note,Name\r\nb,a"));
it("A-6-221 relation titles", () => { const relation = prop({ id: "rel", name: "Relation", type: "relation" }), database = db([relation], [row({ rel: ["target"] })]); expect(rowsToCsv(database.properties, database.rows, database, { target: page({ title: "Target" }) })).toBe("Relation\r\nTarget"); });
it("A-6-222 multiselect display", () => { const multi = prop({ id: "multi", name: "Tags", type: "multiSelect", options: [{ id: "a", name: "one", color: "red" }, { id: "b", name: "two", color: "blue" }] }); expect(csv([{ multi: ["a", "b"] }], [multi])).toBe('Tags\r\n"one, two"'); });

import { stripHtml, blockColorClass } from "@/lib/utils";
it("A-6-253 strip markup", () => { expect(stripHtml("<b>bold</b> and <i>italic</i>")).toBe("bold and italic"); expect(stripHtml("<p>hi</p>")).toBe("hi"); });
it("A-6-254 block color class", () => expect(["red", "bg-red", "default", undefined].map(blockColorClass)).toEqual(["tc-red", "bc-red", "", ""]));

it("GE-1 slugify", () => {
  expect(slugify("Café Plan!")).toBe("cafe-plan"); expect(slugify("")).toBe("untitled");
  expect(slugify("a".repeat(80))).toHaveLength(60); expect(slugify("--x--")).toBe("x");
});
it("GE-2 exportPath uses the short id", () => expect(exportPath(page({ id: "abcdefghijkl", title: "Hello" }))).toBe("hello-abcdefgh.md"));
it("GE-3 front matter of a row page carries its properties", () => {
  const d = page({ id: "d", database: db([prop({ id: "title", name: "Name" }), prop({ id: "status", name: "Status", type: "select", options: [{ id: "done", name: "Done", color: "green" }] })], [row({ title: "Row", status: "done" }, "r")]) });
  const r = page({ id: "r", parentId: d.id }), matter = frontMatter(r, { d, r });
  expect(matter).toContain(`parent: "${exportPath(d)}"`);
  expect(matter).toContain('"Status": "Done"'); expect(matter).not.toContain('"Name"');
});
it("GE-4 internal links are rewritten only when the page exists", () => {
  expect(rewriteInternalLinks("[a](/p/abcdefghijkl) [b](/p/zzz)", { abcdefghijkl: page({ id: "abcdefghijkl", title: "A" }) })).toBe("[a](a-abcdefgh.md) [b](/p/zzz)");
});
it("GE-5 layout", () => {
  const a = page({ id: "aaaaaaaa1111", title: "Alpha" }), b = page({ id: "bbbbbbbb2222", title: "Beta" }), trash = page({ id: "cccccccc3333", title: "Gone", isDeleted: true });
  const entries = buildGitExport({ a, b, trash }, new Set(), new Date(T));
  expect(entries.map((entry) => entry.name).sort()).toEqual(["README.md", "alpha-aaaaaaaa.md", "beta-bbbbbbbb.md", "memory/README.md", "procedures/README.md"]);
  expect(new TextDecoder().decode(entries.find((entry) => entry.name === "memory/README.md")!.data)).toContain("later");
});
it("GE-6 round trip through the zip", async () => {
  const a = page({ id: "aaaaaaaa1111", title: "Alpha" });
  const entries = await readZip(await writeZip(buildGitExport({ a }, new Set(), new Date(T)), new Date(T)).arrayBuffer());
  expect(entries.some((entry) => new TextDecoder().decode(entry.data).startsWith("---\nid: "))).toBe(true);
});
