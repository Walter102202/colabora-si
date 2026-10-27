import { expect, it } from "vitest";
import { inlineMdToHtml, markdownToBlocks, markdownToPage } from "@/lib/markdown";

const inlineCases: [number, [string, string][]][] = [
  [89, [["**bold**", "<strong>bold</strong>"], ["__bold__", "<strong>bold</strong>"], ["*it*", "<em>it</em>"], ["_it_", "<em>it</em>"], ["~~gone~~", "<s>gone</s>"]]],
  [90, [["[text](https://a.test)", '<a href="https://a.test">text</a>'], ['[text](https://a.test "Title")', '<a href="https://a.test">text</a>']]],
  [91, [["<b>x</b>", "&lt;b&gt;x&lt;/b&gt;"], ["a & b", "a &amp; b"]]],
  [92, [["`**not bold**`", "<code>**not bold**</code>"], ["`<b>`", "<code>&lt;b&gt;</code>"]]],
  [93, [["`a` and `b`", "<code>a</code> and <code>b</code>"]]],
  [94, [["I have 3 dogs", "I have 3 dogs"], ["a ` b", "a ` b"], ["2 * 3 * 4", "2 * 3 * 4"]]],
  [95, [["snake_case_name", "snake_case_name"], ["a __b__ c", "a <strong>b</strong> c"], ["foo__bar__baz", "foo__bar__baz"], ["(_em_)", "(<em>em</em>)"]]],
];
it.each(inlineCases)("A-6-%i inline Markdown", (_id, cases) => { for (const [input, output] of cases) expect(inlineMdToHtml(input)).toBe(output); });
const blockCases: [number, string, Record<string, unknown>[]][] = [
  [96, "# One\n## Two\n### Three", [{ type: "heading1" }, { type: "heading2" }, { type: "heading3" }]],
  [97, "#### Four\n##### Five\n###### Six", Array(3).fill({ type: "heading3" })],
  [98, "# **Big**", [{ html: "<strong>Big</strong>" }]], [99, "#NoSpace", [{ type: "paragraph" }]],
  [100, "- a\n* b\n+ c", Array(3).fill({ type: "bulleted" })],
  [101, "1. one\n2. two\n7. seven", [{ type: "numbered" }, { type: "numbered" }, { type: "numbered", html: "seven" }]],
  [102, "- [ ] open\n- [x] done\n- [X] also done", [false, true, true].map((checked) => ({ type: "todo", checked }))],
  [103, "- a\n  - b\n    - c\n\t- t", [0, 1, 2, 1].map((indent) => ({ indent }))],
  [104, "- [x] task", [{ type: "todo" }]], [105, "> quoted\n>tight", [{ type: "quote", html: "quoted" }, { type: "quote" }]],
  [106, "---\n***\n___", Array(3).fill({ type: "divider" })],
  [107, "```js\nconst a = 1;\nconst b = 2;\n```", [{ type: "code", language: "js", html: "const a = 1;\nconst b = 2;" }]],
  [108, "```c++\na\n```\n```objective-c\nb\n```\n```f#\nc\n```", ["c++", "objective-c", "f#"].map((language) => ({ language }))],
  [109, "```\ncode\n```", [{ language: "plaintext" }]],
  [110, "```\n# not a heading\n- not a list\n```", [{ html: "# not a heading\n- not a list" }]],
  [111, "```js\nunclosed", [{ type: "code", html: "unclosed" }]], [112, "```\na\n\nb\n```", [{ html: "a\n\nb" }]],
  [113, "one\n\n\ntwo", [{ type: "paragraph" }, { type: "paragraph" }]],
  [114, "![A cat](https://img.test/cat.png)\n![](https://img.test/cat.png)", [{ type: "image", url: "https://img.test/cat.png", caption: "A cat" }, { caption: undefined }]],
  [115, "# H\r\n\r\ntext", [{ type: "heading1" }, { type: "paragraph" }]],
  [116, "", [{ type: "paragraph", html: "" }]], [117, "I have 3 dogs", [{ html: "I have 3 dogs" }]],
];
it.each(blockCases)("A-6-%i Markdown blocks", (_id, input, expected) => expect(markdownToBlocks(input)).toMatchObject(expected));
it.each([
  [118, "# My page\n\nbody", "My page", null], [119, "# 🚀 Launch plan\n\nbody", "Launch plan", "🚀"],
  [120, "just text", "Imported", null], [121, "# Only a title", "Only a title", null], [122, "# **Bold** title", "Bold title", null],
])("A-6-%i Markdown page", (_id, input, title, icon) => expect(markdownToPage(input as string)).toMatchObject({ title, icon, blocks: [{ type: "paragraph" }] }));
