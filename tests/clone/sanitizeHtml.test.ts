// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/utils";

const cases: [string, string, string][] = [
  ...["b", "strong", "i", "em", "u", "s", "strike", "code", "mark", "sup", "sub"].map((tag): [string, string, string] => ["A-4-33 formatting tags", `<${tag}>x</${tag}>`, `<${tag}>x</${tag}>`]),
  ["A-4-34 breaks and spans", "a<br>b<span>x</span>", "a<br>b<span>x</span>"],
  ["A-4-35 text", "just text", "just text"],
  ["A-4-35 empty", "", ""],
  ["A-4-36 nesting", '<strong>bold <em>and italic</em></strong><span class="tc-red">red <code>code</code> tail</span>', '<strong>bold <em>and italic</em></strong><span class="tc-red">red <code>code</code> tail</span>'],
  ["A-4-37 unwrap paragraphs", "<div>hello</div><p>a</p><p>b</p>", "helloab"],
  ["A-4-38 unwrap tables", "<div><b>bold</b></div><table><tr><td><i>x</i></td></tr></table>", "<b>bold</b><i>x</i>"],
  ["A-4-39 scripts", '<script>alert("xss")</script>', ""],
  ["A-4-40 styles", "<style>body{display:none}</style>", ""],
  ["A-4-41 iframes", "<iframe></iframe>", ""],
  ["A-4-42 unsafe elements", '<img src="x" onerror="alert(1)"><object data="x"></object><svg><circle /></svg>', ""],
  ["A-4-43 nested unsafe elements", '<div><script>bad()</script><img src="x" onerror="alert(1)"><div><iframe></iframe><div><b>deep</b></div></div></div>', "<b>deep</b>"],
  ["A-4-44 promoted attributes", '<div><b onclick="x()" class="evil">t</b></div>', "<b>t</b>"],
  ["A-4-45 nested script text", "<b>safe<script>bad()</script></b>", "<b>safe</b>"],
  ["A-4-46 event handlers", '<b onclick="steal()">x</b><span onmouseover="x()">y</span>', "<b>x</b><span>y</span>"],
  ["A-4-47 style attributes", '<b style="position:fixed">x</b>', "<b>x</b>"],
  ["A-4-48 arbitrary data", '<span data-evil="1">x</span>', "<span>x</span>"],
  ["A-4-49 editability", '<span contenteditable="false">x</span><span contenteditable="true">x</span>', '<span contenteditable="false">x</span><span>x</span>'],
  ["A-4-56 color and math classes", '<span class="tc-blue bc-yellow math-frac">x</span>', '<span class="tc-blue bc-yellow math-frac">x</span>'],
  ["A-4-57 marker classes", '<span class="mention date-mention inline-eq math-render">x</span>', '<span class="mention date-mention inline-eq math-render">x</span>'],
  ["A-4-58 mixed classes", '<span class="evil tc-red">x</span>', '<span class="tc-red">x</span>'],
  ["A-4-59 unknown classes", '<span class="evil other">x</span>', "<span>x</span>"],
  ["A-4-60 equation marker", '<span class="inline-eq" data-eq="x^2">x²</span>', '<span class="inline-eq" data-eq="x^2">x²</span>'],
  ["A-4-61 unmarked equation", '<span data-eq="x^2">x</span>', "<span>x</span>"],
  ["A-4-62 date marker", '<span class="date-mention" data-date="2026-08-13">Aug 13</span>', '<span class="date-mention" data-date="2026-08-13">Aug 13</span>'],
  ...["13/08/2026", "2026-8-13", "2026-08-13T10:00", "tomorrow", ""].map((date): [string, string, string] => ["A-4-63 invalid dates", `<span class="date-mention" data-date="${date}">x</span>`, '<span class="date-mention">x</span>']),
  ["A-4-64 unmarked date", '<span class="whatever" data-date="2026-08-13">x</span>', "<span>x</span>"],
];
it.each(cases)("%s", (_name, input, expected) => expect(sanitizeHtml(input)).toBe(expected));
it("A-4-50 safe anchors gain link protections", () => {
  expect(sanitizeHtml('<a href="https://example.test">link</a>')).toBe('<a href="https://example.test" rel="noopener noreferrer" target="_blank">link</a>');
});
it.each([
  ["A-4-51", "javascript:alert(1)"], ["A-4-52", " javascript:alert(1)"], ["A-4-52", "JaVaScRiPt:alert(1)"],
  ["A-4-53", "data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"], ["A-4-53", "vbscript:msgbox(1)"], ["A-4-53", "file:///etc/passwd"], ["A-4-54", "java\nscript:alert(1)"],
])("%s rejects href %s", (_id, href) => {
  expect(sanitizeHtml(`<a href="${href}">x</a>`)).toBe('<a rel="noopener noreferrer" target="_blank">x</a>');
});
it("A-4-55 page mentions retain their destination", () => {
  const clean = sanitizeHtml('<a href="/p/abc123" data-page="abc123" class="mention">Page</a>');
  expect(clean).toContain('href="/p/abc123"');
  expect(clean).toContain('data-page="abc123"');
  expect(clean).toContain('class="mention"');
});
it("A-4-65 sanitization is idempotent", () => {
  const rich = '<b>bold</b> <span class="tc-red">red</span> <span class="inline-eq" data-eq="a+b">a+b</span> <span class="date-mention" data-date="2026-08-13">Aug 13</span> <a href="https://example.test" rel="noopener noreferrer" target="_blank">link</a>';
  expect(sanitizeHtml(sanitizeHtml(rich))).toBe(sanitizeHtml(rich));
});
it("X-1 hostile paste removes executable content and unsafe hrefs", () => {
  expect(sanitizeHtml('<p onclick="x">a<script>b</script><a href="javascript:alert(1)">c</a><img src="data:text/html,x"></p>')).toBe('a<a rel="noopener noreferrer" target="_blank">c</a>');
});
