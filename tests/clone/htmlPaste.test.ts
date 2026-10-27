// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { htmlToBlocks } from "@/lib/htmlPaste";
const cases: [number, string, Record<string, unknown>[]][] = [
  [66, "<h1>A</h1><h2>B</h2><h3>C</h3>", [1, 2, 3].map((n) => ({ type: `heading${n}` }))],
  [67, "<h4>A</h4><h5>B</h5><h6>C</h6>", Array(3).fill({ type: "heading3" })],
  [68, "<h1>A <b>bold</b> title</h1>", [{ html: "A <b>bold</b> title" }]], [69, "<h1>  spaced  </h1>", [{ html: "spaced" }]],
  [70, "<p>hello</p>", [{ type: "paragraph", html: "hello" }]], [71, "just text", [{ type: "paragraph", html: "just text" }]],
  [73, "<p>a<br>b</p>", [{ html: "a<br>b" }]], [74, "<p>   </p><p></p>   ", []], [75, "", []],
  [76, "loose text<h1>Heading</h1>", [{ type: "paragraph", html: "loose text" }, { type: "heading1" }]],
  [77, "<b>bold</b>", [{ type: "paragraph", html: "<b>bold</b>" }]],
  [79, '<p><font color="red">red</font> text</p>', [{ html: "red text" }]],
  [80, '<b id="docs-internal-guid-1"><p>a</p><p>b</p></b>', [{ type: "paragraph", html: "a" }, { type: "paragraph", html: "b" }]],
  [81, "<ul><li>a</li><li>b</li></ul><ol><li>a</li></ol>", ["bulleted", "bulleted", "numbered"].map((type) => ({ type }))],
  [82, "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>", ["a", "b", "c"].map((html, indent) => ({ html, indent }))],
  [83, "<ul><li>a<ol><li>b</li></ol></li></ul>", [{ type: "bulleted" }, { type: "numbered" }]],
  [84, "<ul><ul><li>x</li></ul></ul>", [{ indent: 1 }]], [85, "<ul><li>a <em>b</em></li></ul>", [{ html: "a <em>b</em>" }]],
  [86, "<ul><li></li></ul>", [{ type: "bulleted", html: "" }]], [87, "<ul>stray<li>a</li></ul>", [{ html: "a" }]],
  [88, '<ul><li><input type="checkbox">open</li></ul>', [{ type: "todo", checked: false, html: "open" }]],
  [89, '<ul><li><input type="checkbox" checked>done</li></ul>', [{ checked: true }]],
  [90, '<ul><li><p><input type="checkbox" checked>done</p></li></ul>', [{ type: "todo", checked: true }]],
  [91, "<ul><li>plain</li></ul>", [{ type: "bulleted" }]],
  [92, "<blockquote><p>a</p><p>b</p></blockquote>", [{ type: "quote" }, { type: "quote" }]],
  [93, "<blockquote>quoted</blockquote>", [{ type: "quote", html: "quoted" }]],
  [94, "<blockquote><h2>H</h2><ul><li>i</li></ul></blockquote>", [{ type: "heading2" }, { type: "bulleted" }]],
  [95, "<pre><code>const a = 1;\n</code></pre>", [{ type: "code", html: "const a = 1;" }]],
  [96, "<pre><code>a\n  b\n\nc</code></pre>", [{ html: "a\n  b\n\nc" }]],
  [97, '<pre><code><span class="k">if</span> (a)</code></pre>', [{ html: "if (a)" }]],
  [98, '<pre><code class="language-python">x</code></pre><pre class="lang-go">x</pre>', [{ language: "python" }, { language: "go" }]],
  [100, '<pre class="language-cobol">x</pre><pre>x</pre><pre class="hljs">x</pre>', Array(3).fill({ language: "plaintext" })],
  [101, "<hr>", [{ type: "divider" }]],
  [102, '<img src="https://i.test/a.png" alt="A cat"><img src="u">', [{ type: "image", url: "https://i.test/a.png", caption: "A cat" }, { caption: "" }]],
  [103, '<img><img alt="no source">', []],
  [104, '<figure><img src="u" alt="alt text"><figcaption>The caption</figcaption></figure>', [{ type: "image", caption: "The caption" }]],
  [105, '<figure><img src="u" alt="alt text"><figcaption> </figcaption></figure><figure><img src="u" alt="alt text"></figure>', [{ caption: "alt text" }, { caption: "alt text" }]],
  [106, "<figure><p>a caption-less figure</p></figure>", [{ type: "paragraph", html: "a caption-less figure" }]],
  [107, "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>", [{ type: "table", table: [["a", "b"], ["c", "d"]] }]],
  [108, "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>", [{ tableHeaderRow: true, table: [["A"], ["1"]] }]],
  [109, "<table><tr><th>A</th><th>B</th></tr></table>", [{ tableHeaderRow: true }]],
  [110, "<table><tr><th>A</th><td>B</td></tr></table>", [{ tableHeaderRow: false }]],
  [111, "<table><tr><td>a</td></tr><tr><td>b</td><td>c</td><td>d</td></tr></table>", [{ table: [["a", "", ""], ["b", "c", "d"]] }]],
  [112, "<table><tr><td><b>a</b></td></tr></table>", [{ table: [["<b>a</b>"]] }]],
  [113, "<table></table>", [{ table: [["", ""]], tableHeaderRow: false }]],
  [114, "<table><tr></tr><tr><td>a</td></tr></table>", [{ table: [["a"]] }]],
  [115, '<style>body{color:red}</style><script>alert(1)</script><meta charset="utf-8"><link rel="x"><title>T</title>', []],
  [116, "<p>a<script>alert(1)</script>b</p>", [{ html: "ab" }]], [117, '<p><b onclick="alert(1)">x</b></p>', [{ html: "<b>x</b>" }]],
  [119, "<div>".repeat(40) + "<p>bottom</p>" + "</div>".repeat(40), [{ type: "paragraph", html: "bottom" }]],
];
it.each(cases)("A-4-%i HTML block paste", (_id, input, expected) => { const result = htmlToBlocks(input); expect(result).toHaveLength(expected.length); expect(result).toMatchObject(expected); });
it("A-4-72 containers preserve paragraphs", () => { for (const tag of ["div", "section", "article", "header", "footer", "main", "aside"]) expect(htmlToBlocks(`<${tag}><p>a</p><p>b</p></${tag}>`).map((b) => b.html)).toEqual(["a", "b"]); });
it("A-4-78 pasted links", () => { const html = htmlToBlocks('<p><a href="https://a.test">link</a></p>')[0].html; expect(html).toContain("<a "); expect(html).toContain("link"); });
it("A-4-99 code language aliases", () => { for (const [alias, language] of Object.entries({ js: "javascript", ts: "typescript", py: "python", rb: "ruby", sh: "bash", shell: "bash", yml: "yaml" })) expect(htmlToBlocks(`<pre class="language-${alias}">x</pre>`)[0].language).toBe(language); });
it("A-4-118 image event attributes cannot survive", () => { const blocks = htmlToBlocks('<p>before <img src=x onerror="alert(1)"> after</p>'); for (const block of blocks) { expect(JSON.stringify(block)).not.toContain("onerror"); expect(block.html).not.toContain("<img"); } });
it("A-4-120 malformed HTML never throws", () => { for (const input of ["<p>unclosed", "<ul><li>a", "<table><tr><td>x", "</p></div>"]) expect(() => htmlToBlocks(input)).not.toThrow(); });
const mixed = '<article><h1>Title</h1><p>Intro with <b>bold</b>.</p><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><blockquote>quote</blockquote><pre class="language-js">code</pre><hr><table><thead><tr><th>A</th></tr></thead></table></article>';
it("A-4-121 mixed document", () => { const blocks = htmlToBlocks(mixed); expect(blocks.map((b) => b.type)).toEqual(["heading1", "paragraph", "bulleted", "bulleted", "bulleted", "quote", "code", "divider", "table"]); expect(blocks.map((b) => b.indent)).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0]); expect(blocks[1].html).toBe("Intro with <b>bold</b>."); expect(blocks[6].language).toBe("javascript"); });
it("A-4-122 block ids and indents", () => { const blocks = htmlToBlocks(mixed); expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length); for (const block of blocks) { expect(block.id).toBeTruthy(); expect(typeof block.indent).toBe("number"); } });
