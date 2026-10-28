import { presenceName, usePresence } from "@/lib/presence";
export default function PresenceAvatars() {
  const users = usePresence((s) => s.others);
  return <div className="flex h-6 items-center" aria-label="People on this page">{users.slice(0, 5).map((user) => <span key={user.userId} className={`presence-avatar ${user.away ? "opacity-50" : ""}`} style={{ background: user.color }} title={user.email + (user.away ? " (away)" : "")}>{presenceName(user.email)[0].toUpperCase()}</span>)}{users.length > 5 && <span className="presence-avatar bg-bg-secondary text-text-secondary" title={users.slice(5).map((u) => u.email).join(", ")}>+{users.length - 5}</span>}</div>;
}
