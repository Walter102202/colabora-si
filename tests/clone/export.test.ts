// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { blocksToMarkdown as md, inlineToMarkdown, pageToMarkdown } from "@/lib/export";
import { markdownToBlocks } from "@/lib/markdown";
import { b, column, db, page, prop, row } from "./fixtures";
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
