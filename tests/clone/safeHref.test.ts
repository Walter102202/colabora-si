import { expect, it } from "vitest";
import { safeHref } from "@/lib/utils";

const cases: [string, (string | null | undefined)[], boolean][] = [
  ["A-6-246 web links", ["https://example.com/a?b=1#c", "http://example.com", "HTTPS://EXAMPLE.COM"], true],
  ["A-6-247 contact links", ["mailto:a@b.com", "tel:+34600000000"], true],
  ["A-6-248 relative links", ["/p/abc123", "#section", "example.com/path", "//cdn.example.com/x"], true],
  ["A-6-249 trims whitespace", ["  https://example.com  "], true],
  ["A-6-250 rejects unsafe schemes", ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"], false],
  ["A-6-251 detects obfuscated schemes", ["java\nscript:alert(1)", "java\tscript:alert(1)", "java script:alert(1)", "jav ascript:alert(1)"], false],
  ["A-6-252 empty links", ["", "   ", null, undefined], false],
];
it.each(cases)("%s", (_name, values, accepted) => {
  for (const value of values) expect(safeHref(value)).toBe(accepted ? value?.trim() : undefined);
});
