import { expect, it } from "vitest";
import { windowRange } from "@/lib/virtualWindow";

it("VW-1 start", () => expect(windowRange(0, 340, 34, 1000, 5)).toEqual({ start: 0, end: 15, padTop: 0, padBottom: 33490 }));
it("VW-2 middle", () => expect(windowRange(3400, 340, 34, 1000, 5)).toEqual({ start: 95, end: 115, padTop: 3230, padBottom: 30090 }));
it("VW-3 end", () => expect(windowRange(33660, 340, 34, 1000, 5)).toEqual({ start: 985, end: 1000, padTop: 33490, padBottom: 0 }));
it("VW-4 fewer rows than the viewport", () => expect(windowRange(0, 340, 34, 5, 5)).toEqual({ start: 0, end: 5, padTop: 0, padBottom: 0 }));
it("VW-5 table below the viewport top", () => expect(windowRange(-500, 340, 34, 1000, 5)).toEqual({ start: 0, end: 15, padTop: 0, padBottom: 33490 }));
