// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { uploadRowFirst, useUploadState } from "@/lib/fileStore";

it("FS-1 the row is written before the object", async () => {
  const calls: string[] = [];
  const backend = { registerRow: async () => { calls.push("row"); return true; }, putObject: async () => { calls.push("object"); return true; } };
  await expect(uploadRowFirst(backend, "f1", "ws", new Blob(["x"]))).resolves.toBe("done");
  expect(calls).toEqual(["row", "object"]);
});
it("FS-2 a failed row stops before the object", async () => {
  const backend = { registerRow: async () => false, putObject: vi.fn(async () => true) };
  await expect(uploadRowFirst(backend, "f1", "ws", new Blob(["x"]))).resolves.toBe("row_failed");
  expect(backend.putObject).not.toHaveBeenCalled();
});
it("FS-3 a failed object keeps the row", async () => {
  const calls: string[] = [];
  const backend = { registerRow: async () => { calls.push("row"); return true; }, putObject: async () => { calls.push("object"); return false; } };
  await expect(uploadRowFirst(backend, "f1", "ws", new Blob(["x"]))).resolves.toBe("object_failed");
  expect(calls).toEqual(["row", "object"]);
});
it("FS-4 upload state toggles per file", () => {
  useUploadState.getState().clear();
  useUploadState.getState().start("a");
  expect(useUploadState.getState().uploading.a).toBe(true);
  useUploadState.getState().finish("a");
  expect(useUploadState.getState().uploading).not.toHaveProperty("a");
  useUploadState.getState().start("b"); useUploadState.getState().clear();
  expect(useUploadState.getState().uploading).toEqual({});
});
