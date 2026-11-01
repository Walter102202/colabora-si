import { claimWorkspace, openLocalDb, readWorkspace } from "@/lib/localDb";
import { startWriter } from "@/lib/localPersistence";
import { installFakeIndexedDb } from "./fakeIndexedDb";

export async function startTestWriter() {
  const fake = installFakeIndexedDb(), db = await openLocalDb();
  await claimWorkspace(db, [], [], null);
  const { epoch } = await readWorkspace(db);
  startWriter(db, epoch);
  return fake;
}
