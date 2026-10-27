import { expect, it } from "vitest";
import { highlightCode } from "@/lib/highlight";
const token = (kind: string, text: string) => `<span class="tok-${kind}">${text}</span>`;
const kw = (s: string) => token("keyword", s), str = (s: string) => token("string", s), num = (s: string) => token("number", s), cmt = (s: string) => token("comment", s), fn = (s: string) => token("fn", s), bool = (s: string) => token("boolean", s);
const cases: [number, [string, string | undefined, string][]][] = [
  [52, [["const x = 1; // not code", "plaintext", "const x = 1; // not code"], ["const x = 1;", "text", "const x = 1;"]]],
  [53, [["const x = 1;", undefined, "const x = 1;"]]],
  [54, [["<b>&</b>", "plaintext", "&lt;b&gt;&amp;&lt;/b&gt;"]]],
  [55, [["", "javascript", ""], ["", "plaintext", ""]]],
  [56, [["const x = 1;", "javascript", `${kw("const")} x = ${num("1")};`]]],
  [57, [["const", "JavaScript", kw("const")], ["const", "TypeScript", kw("const")]]],
  [58, [["foo(1)", "javascript", `${fn("foo")}(${num("1")})`]]],
  [59, [["true null undefined", "javascript", ["true", "null", "undefined"].map(bool).join(" ")]]],
  [60, [["true nil", "go", kw("true") + " " + kw("nil")]]],
  [61, [["interface", "typescript", kw("interface")], ["interface", "javascript", "interface"]]],
  [62, ['"a"', "'a'", "`a`"].map((text) => [text, "javascript", str(text)])],
  [63, [['"a\\\"b"', "javascript", str('"a\\\"b"')]]],
  [64, [['"const"', "javascript", str('"const"')]]],
  [65, [["// hi", "javascript", cmt("// hi")], ["/* hi */", "javascript", cmt("/* hi */")]]],
  [66, [["// const x", "javascript", cmt("// const x")]]],
  [67, [["// c\nx", "javascript", cmt("// c") + "\nx"]]],
  [68, [["0xFF + .5 + 1e3", "javascript", ["0xFF", ".5", "1e3"].map(num).join(" + ")]]],
  [69, [["def", "python", kw("def")], ["elif", "python", kw("elif")], ["const", "python", "const"]]],
  [70, [["# note", "python", cmt("# note")], ["/* x */", "python", "/* x */"]]],
  [71, [["def go(x):", "python", `${kw("def")} ${fn("go")}(x):`]]],
  [72, [["-- note", "sql", cmt("-- note")], ["/* note */", "sql", cmt("/* note */")]]],
  [73, [["select", "from"], ["SELECT", "FROM"], ["Select", "From"]].map(([a, b]) => [`${a} * ${b} users`, "sql", `${kw(a)} * ${kw(b)} users`])],
  [74, [["x IS NOT NULL", "sql", `x IS ${kw("NOT")} ${kw("NULL")}`]]],
  [75, [["If", "javascript", "If"], ["if", "javascript", kw("if")]]],
  [76, [["# note", "bash", cmt("# note")], ["if", "bash", kw("if")]]],
  [77, [["# note", "yaml", cmt("# note")], ["if", "yaml", "if"]]],
  [78, [['const x = 1; // c\n"s"', "brainfuck", `const x = ${num("1")}; ${cmt("// c")}\n${str('"s"')}`]]],
  [79, [['<div class="a">1</div>', "html", `&lt;div class=${str('"a"')}&gt;${num("1")}&lt;/div&gt;`]]],
  [80, [["# heading", "markdown", "# heading"]]],
  [81, [['"abc', "javascript", str('"abc')], ["'abc", "python", str("'abc")]]],
  [82, [["/* abc", "javascript", cmt("/* abc")]]],
  [83, [['"', "javascript", str('"')]]],
  [86, [['"<script>"', "javascript", str('"&lt;script&gt;"')], ["// <script>", "javascript", cmt("// &lt;script&gt;")], ["<script>", "javascript", "&lt;script&gt;"]]],
  [88, [["a && b", "javascript", "a &amp;&amp; b"], ["&lt;", "javascript", "&amp;lt;"]]],
];
it.each(cases)("A-6-%s highlighted output", (_id, entries) => { for (const [input, language, output] of entries) expect(highlightCode(input, language)).toBe(output); });
it("A-6-84 trailing escape", () => expect(() => highlightCode('"abc\\', "javascript")).not.toThrow());
it("A-6-85 scanner always advances", () => expect(() => highlightCode('"'.repeat(2000) + "\n" + "/*".repeat(2000), "javascript")).not.toThrow());
it("A-6-87 tags and attributes stay text", () => { const out = highlightCode('<img src=x onerror="alert(1)">', "javascript"); expect(out).not.toContain("<img"); expect(out).not.toContain('onerror="alert'); expect(out.replace(/<\/?span\b[^>]*>/g, "")).not.toContain("<"); });
