import { pageUrl } from "@/lib/routes";
import { useNavigate } from "react-router";
import Modal from "@/components/Modal";
import { TEMPLATES } from "@/lib/templates";
import { useStore } from "@/lib/store";
import { withViewTransition } from "@/lib/viewTransition";
export default function TemplateModal({ pageId, onClose }: { pageId?: string; onClose: () => void }) {
  const navigate = useNavigate();
  return <Modal title="Templates" onClose={onClose} wide><p className="px-5 py-3 text-sm text-text-secondary">{pageId ? "Pick a template to fill this page." : "Start a new page from a template."}</p><div className="overflow-y-auto px-5 pb-5">{["Personal", "Work", "Database"].map((category) => <section key={category}><h3 className="section-label">{category}</h3><div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{TEMPLATES.filter((t) => t.category === category).map((template) => <button key={template.id} className={`template-card ${template.id === "agent-tasks" ? "featured-template" : ""}`} onClick={() => { const plan = template.build(); if (pageId) useStore.getState().applyTemplate(pageId, plan); else { const id = useStore.getState().createPageFromTemplate(plan); withViewTransition(() => navigate(pageUrl(id))); } onClose(); }}><span className="text-2xl">{template.icon}</span><span><span className="block text-sm font-medium">{template.name}</span><span className="block text-xs text-text-tertiary">{template.description}</span></span></button>)}</div></section>)}</div></Modal>;
}
