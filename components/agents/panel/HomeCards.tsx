import type { ReactNode } from "react";

// A section of the home made of decision cards. Empty, it renders nothing: the home stays as it was.
export function HomeCards({ title, items }: { title: string; items: ReactNode[] }) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className="mb-12 space-y-2">
      <h2 className="mb-3 text-xs text-text-tertiary">{title} ({items.length})</h2>
      {items}
    </section>
  );
}
