// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CoverPicker from "@/components/CoverPicker";
import { COVER_GRADIENTS, COVER_IMAGES, safeCover } from "@/lib/cover";

const covers = [
  ["On the same page", "same-page"],
  ["Gardener", "gardener"],
  ["Chef", "chef"],
  ["Detective", "detective"],
  ["Conductor", "conductor"],
  ["Explorer", "explorer"],
] as const;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount() {
  const onSelect = vi.fn(), onClose = vi.fn();
  act(() => root.render(<CoverPicker onSelect={onSelect} onClose={onClose} />));
  return { onSelect, onClose };
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === name);
  expect(button, `cover button named ${name}`).toBeDefined();
  return button!;
}

it("offers the six named Trama thumbnails before the existing cover choices", () => {
  mount();
  const section = host.querySelector('[aria-label="Trama covers"]');
  expect(section).not.toBeNull();
  expect([...section!.querySelectorAll("button img")]).toHaveLength(6);
  for (const [name, slug] of covers) {
    const button = buttonNamed(name);
    expect(button.type).toBe("button");
    expect(button.querySelector("img")?.getAttribute("src")).toBe(`/brand/trama/covers/v1/${slug}-thumb.webp`);
    expect(button.querySelector("img")?.getAttribute("alt")).toBe("");
  }
  expect(host.textContent!.indexOf("Trama")).toBeLessThan(host.textContent!.indexOf("Gradients"));
  expect(host.textContent).toContain("Images");
  expect(host.querySelector('input[placeholder="Paste image URL…"]')).not.toBeNull();
});

it("selects full Trama covers as absolute URLs and closes after selecting each one", () => {
  const { onSelect, onClose } = mount();
  for (const [name, slug] of covers) {
    onSelect.mockClear();
    onClose.mockClear();
    act(() => buttonNamed(name).click());
    const path = `/brand/trama/covers/v1/${slug}.webp`;
    const absolute = `${window.location.origin}${path}`;
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(absolute);
    expect(safeCover(absolute)).toBe(absolute);
    expect(safeCover(path)).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  }
});

it("keeps gradient and existing image selection working", () => {
  const { onSelect, onClose } = mount();
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Gradient 1"]')!.click());
  expect(onSelect).toHaveBeenLastCalledWith(COVER_GRADIENTS[0]);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Cover image 1"]')!.click());
  expect(onSelect).toHaveBeenLastCalledWith(COVER_IMAGES[0]);
  expect(onClose).toHaveBeenCalledTimes(2);
});
