import { Link, useNavigate } from "react-router";
import { createBlock } from "@/lib/factories";
import { createLinkedViews } from "@/lib/dbOps";
import { useStore } from "@/lib/store";
import { pageUrl } from "@/lib/routes";

export default function LinkedPage() {
  const pages = useStore((s) => s.pages), navigate = useNavigate();
  const databases = Object.values(pages).filter((page) => !page.isDeleted && page.database);
  return <div className="page-content"><title>Linked databases · colabora.si</title><h1 className="mb-6 text-3xl font-bold">Linked databases</h1>
    <p className="mb-4 text-sm text-text-secondary">Choose a database to create a linked page with its own views.</p>
    {databases.map((page) => <div key={page.id} className="mb-3 flex items-center gap-4">
      <Link to={pageUrl(page.id)} className="text-accent">{page.title || "Untitled database"}</Link>
      <button className="action-button" onClick={() => {
        const id = useStore.getState().createPage(null, { title: page.title || "Linked database", blocks: [createBlock("database", { pageId: page.id, linkedViews: createLinkedViews(page.database!) })] });
        void navigate(pageUrl(id));
      }}>Create linked page</button>
    </div>)}
    {!databases.length && <p>No databases yet.</p>}
  </div>;
}
