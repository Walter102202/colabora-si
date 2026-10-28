import { renderMath } from "@/lib/math";
export default function MathPreview({ source }: { source: string }) {
  return <div className="math-render p-2" dangerouslySetInnerHTML={{ __html: renderMath(source) }} />;
}
