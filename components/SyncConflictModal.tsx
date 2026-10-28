import Modal from "@/components/Modal";
import { useSyncConflict } from "@/lib/sync";
export default function SyncConflictModal() {
  const prompt = useSyncConflict((s) => s.prompt);
  if (!prompt) return null;
  return <div className="sync-conflict-modal"><Modal title="This workspace already exists in the cloud" onClose={() => {}} dismissible={false}><div className="space-y-4 p-6">
    <p className="text-sm text-text-secondary">Your account has {prompt.serverPageCount} {prompt.serverPageCount === 1 ? "page" : "pages"} in the cloud, and this device has {prompt.localPageCount} local {prompt.localPageCount === 1 ? "page" : "pages"} that differ. Choose how to combine them — sync starts right after.</p>
    <button className="sync-choice border-accent" onClick={() => prompt.resolve("merge")}><strong>Merge (recommended)</strong><span>Keep local pages and cloud pages. Pending edits are applied to the cloud copy.</span></button>
    <button className="sync-choice" onClick={() => prompt.resolve("server")}><strong>Keep server</strong><span>Use the cloud workspace. Pages that exist only on this device are removed here.</span></button>
    <button className="sync-choice" onClick={() => prompt.resolve("local")}><strong>Keep local</strong><span>Use this device&apos;s workspace. The cloud copy is overwritten and pages that exist only in the cloud are deleted.</span></button>
    <p className="text-xs text-text-tertiary">Tip: export a JSON backup first from Settings → Data if you&apos;re unsure.</p>
  </div></Modal></div>;
}
