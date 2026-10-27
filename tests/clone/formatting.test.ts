// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { shortcutFormat } from "@/lib/formatting";
const key = (key: string, mods: Partial<Parameters<typeof shortcutFormat>[0]> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
it("A-4-26 control formatting shortcuts", () => { for (const [k, action] of [["b", "bold"], ["i", "italic"], ["u", "underline"], ["e", "code"], ["k", "link"]]) expect(shortcutFormat(key(k, { ctrlKey: true }))).toBe(action); });
it("A-4-27 command shortcuts", () => { expect(shortcutFormat(key("b", { metaKey: true }))).toBe("bold"); expect(shortcutFormat(key("k", { metaKey: true }))).toBe("link"); });
it("A-4-28 uppercase shortcut", () => expect(shortcutFormat(key("B", { ctrlKey: true }))).toBe("bold"));
it("A-4-29 shifted shortcut", () => { expect(shortcutFormat(key("s", { ctrlKey: true, shiftKey: true }))).toBe("strike"); expect(shortcutFormat(key("b", { ctrlKey: true, shiftKey: true }))).toBeNull(); });
it("A-4-30 no modifier", () => expect(shortcutFormat(key("b"))).toBeNull());
it("A-4-31 alt belongs to OS", () => expect(shortcutFormat(key("b", { ctrlKey: true, altKey: true }))).toBeNull());
it("A-4-32 unrelated keys", () => { for (const k of ["a", "z", "1", "Enter", "s"]) expect(shortcutFormat(key(k, { ctrlKey: true }))).toBeNull(); });
