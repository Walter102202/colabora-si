import { TRAMA } from "@/lib/tramaIdentity";

export type TramaSize = 24 | 28 | 32 | 40 | 96;

// The approved character is never tinted, clipped, animated or given a background.
export function TramaAvatar({ size = 32, decorative = false }: { size?: TramaSize; decorative?: boolean }) {
  return <img className="block shrink-0" style={{ width: size, height: size, objectFit: "contain" }}
    src={TRAMA.src} srcSet={TRAMA.srcSet} sizes={`${size}px`} width={size} height={size}
    alt={decorative ? "" : TRAMA.alt} draggable={false} />;
}
