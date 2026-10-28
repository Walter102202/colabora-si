export default function Emoji({ emoji, size = 18, className = "" }: { emoji: string; size?: number; className?: string }) {
  return emoji ? <span className={`inline-block select-none leading-none ${className}`} style={{ fontSize: size, width: size, height: size }}>{emoji}</span> : null;
}
