// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { enqueueUpload, uploadRowFirst, useUploadState } from "@/lib/fileStore";

// A configured backend with no workspace yet: the usual dev setup with `.env` and no session.
vi.mock("@/lib/supabase", async (original) => ({ ...(await original<typeof import("@/lib/supabase")>()), getSupabase: () => ({}) as never }));

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
it("FS-5 a file put before the workspace is known is not reported as uploading", () => {
  useUploadState.getState().clear();
  enqueueUpload("f-before-login"); // nothing can be sent yet; onFileSyncStart re-enqueues it once the workspace is known
  expect(useUploadState.getState().uploading).toEqual({});
});
