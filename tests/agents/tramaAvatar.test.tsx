// @vitest-environment happy-dom
import { existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TramaAvatar } from "@/components/agents/TramaAvatar";
import { isTrama, TRAMA } from "@/lib/tramaIdentity";

it("renders the approved image without visual alterations at both display sizes", () => {
  for (const size of [28, 96] as const) {
    const holder = document.createElement("div");
    holder.innerHTML = renderToStaticMarkup(<TramaAvatar size={size} />);
    const img = holder.querySelector("img")!;
    expect(img.getAttribute("srcset")).toBe(TRAMA.srcSet);
    expect(img.alt).toBe(TRAMA.alt);
    expect(img.style.objectFit).toBe("contain");
    expect(img.style.filter).toBe("");
    expect(img.style.opacity).toBe("");
    expect(img.className).not.toMatch(/rounded|overflow|shadow|animate|opacity|filter/);
  }
  for (const size of [64, 128, 256, 512]) expect(existsSync(`public/brand/trama/v1/trama-${size}.png`)).toBe(true);
});

it("identifies the platform agent independently of its editable name", () => {
  expect(isTrama({ is_platform: true })).toBe(true);
  expect(isTrama({ is_platform: false })).toBe(false);
  expect(isTrama(null)).toBe(false);
  expect(renderToStaticMarkup(<TramaAvatar decorative />)).toContain('alt=""');
});
