import { expect, it } from "vitest";
import { renderMath } from "@/lib/math";
const frac = (n: string, d: string) => `<span class="math-frac"><span class="math-num">${n}</span><span class="math-den">${d}</span></span>`;
const sqrt = (r: string) => `<span class="math-sqrt"><span class="math-sqrt-sign">√</span><span class="math-sqrt-rad">${r}</span></span>`;
const acc = (m: string, b: string) => `<span class="math-acc"><span class="math-acc-mark">${m}</span>${b}</span>`;
const up = (s: string) => `<span style="font-style:normal">${s}</span>`;
const cases: [number, [string, string][]][] = [
  [1, [["\\alpha", "α"], ["\\beta", "β"], ["\\lambda\\mu\\pi", "λμπ"]]],
  [2, [["\\Delta", "Δ"], ["\\Omega", "Ω"]]],
  [3, [["a \\times b", "a × b"], ["a \\leq b \\geq c", "a ≤ b ≥ c"], ["\\infty", "∞"], ["x \\in A \\cup B", "x ∈ A ∪ B"]]],
  [4, [["\\le", "≤"], ["\\leq", "≤"], ["\\ge", "≥"], ["\\geq", "≥"], ["\\ne", "≠"], ["\\neq", "≠"]]],
  [5, [["\\sum", "∑"], ["\\prod", "∏"], ["\\int", "∫"]]],
  [6, [["\\notacommand", "notacommand"], ["\\foo bar", "foo bar"]]],
  [7, [["2 + 2 = 4", "2 + 2 = 4"]]],
  [8, [["x^2", "x<sup>2</sup>"], ["a_i", "a<sub>i</sub>"]]],
  [9, [["x^{10}", "x<sup>10</sup>"], ["a_{i+1}", "a<sub>i+1</sub>"]]],
  [10, [["x^12", "x<sup>1</sup>2"]]],
  [11, [["x^\\alpha", "x<sup>α</sup>"], ["e^{\\pi i}", "e<sup>π i</sup>"]]],
  [12, [["\\sum_{i=1}^{n}", "∑<sub>i=1</sub><sup>n</sup>"]]],
  [13, [["x^{y^2}", "x<sup>y<sup>2</sup></sup>"]]],
  [14, [["x^", "x<sup></sup>"], ["x_", "x<sub></sub>"]]],
  [15, [["\\frac{a}{b}", frac("a", "b")], ["\\dfrac{1}{2}", frac("1", "2")], ["\\tfrac{1}{2}", frac("1", "2")]]],
  [16, [["\\frac12", frac("1", "2")]]],
  [17, [["\\frac{\\frac{a}{b}}{c}", frac(frac("a", "b"), "c")]]],
  [18, [["\\frac{\\pi}{x^2}", frac("π", "x<sup>2</sup>")]]],
  [19, [["\\frac{a", frac("a", "")]]],
  [20, [["\\sqrt{x}", sqrt("x")], ["\\sqrt{x^2 + y^2}", sqrt("x<sup>2</sup> + y<sup>2</sup>")]]],
  [21, [["\\sqrt2", sqrt("2")]]],
  [26, [["\\text{if}", up("if")], ["\\mathrm{d}", up("d")], ["\\operatorname{d}", up("d")]]],
  [27, [["\\mathbf{v}", '<span style="font-weight:600;font-style:normal">v</span>'], ["\\mathit{v}", '<span style="font-style:italic">v</span>']]],
  [28, [["\\sin", up("sin")], ["\\lim", up("lim")], ["\\log_2 n", up("log") + "<sub>2</sub> n"]]],
  [29, [["\\hat{x}", acc("ˆ", "x")], ["\\bar{x}", acc("‾", "x")], ["\\overline{x}", acc("‾", "x")], ["\\vec{v}", acc("→", "v")], ["\\tilde{x}", acc("˜", "x")], ["\\dot{x}", acc("˙", "x")]]],
  [30, [["\\vec v", acc("→", " ") + "v"]]],
  [31, [["\\left( x \\right)", "( x )"], ["\\left[ x \\right]", "[ x ]"]]],
  [32, [["\\left. x \\right.", " x "]]],
  [33, [["a\\,b", "a\u2009b"], ["a\\;b", "a\u2005b"], ["a\\:b", "a\u2005b"], ["a\\ b", "a b"]]],
  [34, [["a\\quad b", "a\u2003 b"], ["a\\qquad b", "a\u2003\u2003 b"]]],
  [35, [["a\\\\b", "a<br/>b"]]],
  [36, [["\\{x\\}", "{x}"]]],
  [37, [["\\left\\{ x \\right\\}", "{ x }"]]],
  [38, [["\\left\\langle x \\right\\rangle", "⟨ x ⟩"]]],
  [39, [["\\left. x \\right\\|", " x |"]]],
  [40, [["a < b", "a &lt; b"], ["a > b", "a &gt; b"], ["a & b", "a &amp; b"], ['say "hi"', "say &quot;hi&quot;"]]],
  [41, [["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"]]],
  [43, [["\\left<", "&lt;"]]],
  [47, [["a}b", "ab"], ["{ab", "ab"]]],
  [51, [["e^{i\\pi} + 1 = 0", "e<sup>iπ</sup> + 1 = 0"]]],
];
it.each(cases)("A-6-%s math output", (_id, entries) => { for (const [input, output] of entries) expect(renderMath(input)).toBe(output); });
it("A-6-22 fraction inside root", () => expect(renderMath("\\sqrt{\\frac{a}{b}}")).toContain("math-frac"));
it("A-6-23 cubic root", () => { const out = renderMath("\\sqrt[3]{x}"); expect(out).toContain('<span class="math-sqrt-index">3</span>'); expect(out).toContain('<span class="math-sqrt-rad">x</span>'); expect(out).not.toContain("3]"); });
it("A-6-24 expression root index", () => expect(renderMath("\\sqrt[n+1]{x}")).toContain('<span class="math-sqrt-index">n+1</span>'));
it("A-6-25 root without index", () => expect(renderMath("\\sqrt{x}")).not.toContain("math-sqrt-index"));
it("A-6-42 escaping inside structures", () => { expect(renderMath("\\text{<b>}")).toContain("&lt;b&gt;"); expect(renderMath("x^{<i>}")).toBe("x<sup>&lt;i&gt;</sup>"); expect(renderMath("\\frac{<}{>}")).toContain("&lt;"); expect(renderMath("\\frac{<}{>}")).not.toContain("<b"); });
it("A-6-44 input cannot create arbitrary tags", () => expect(renderMath('<img src=x onerror="alert(1)">').replace(/<\/?(?:sup|sub|span|br)\b[^>]*>/g, "")).not.toContain("<"));
it("A-6-45 malformed input is text", () => { for (const input of ["", "\\", "a\\", "{a", "a}b", "\\frac{", "\\sqrt{", "\\left", "{}{}{}", "^_^", "\\1\\2"]) expect(typeof renderMath(input)).toBe("string"); });
it("A-6-46 nullish input", () => { for (const input of ["", undefined, null]) expect(renderMath(input as unknown as string)).toBe(""); });
it("A-6-48 long symbol expression", () => expect(renderMath("\\alpha + ".repeat(500) + "\\omega")).toMatch(/ω$/));
it("A-6-49 quadratic expression", () => { const out = renderMath("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"); for (const expected of ["math-frac", "math-sqrt", "±", "b<sup>2</sup>"]) expect(out).toContain(expected); });
it("A-6-50 sum expression", () => { const out = renderMath("\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}"); expect(out).toContain("∑<sub>n=1</sub><sup>∞</sup>"); expect(out).toContain("π<sup>2</sup>"); });
