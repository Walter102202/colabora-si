import { TRAMA } from "@/lib/tramaIdentity";

// The approved image is never altered: the stylesheet only sizes the whole character.
export function TramaImage({ px, alt = "", id, lazy = false }: { px: number; alt?: string; id?: string; lazy?: boolean }) {
  return <img id={id} src={TRAMA.src} srcSet={TRAMA.srcSet} sizes={`${px}px`} width={px} height={px} alt={alt} draggable={false} loading={lazy ? "lazy" : undefined} />;
}
