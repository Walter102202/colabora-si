"use client";
import { use } from "react";
import { useStore } from "@/lib/store";

export default function PageRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const page = useStore((s) => s.pages[id]);
  return <div className="page-content"><h1 className="title-edit">{page?.title || (page ? "Untitled" : "Page not found.")}</h1></div>;
}
