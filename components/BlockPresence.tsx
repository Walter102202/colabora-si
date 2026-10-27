"use client";
import { presenceName, usePresence } from "@/lib/presence";
export default function BlockPresence({ blockId }: { blockId: string }) {
  const users = usePresence((s) => s.byBlock[blockId]);
  if (!users?.length) return null;
  return <div className="block-presence" contentEditable={false} aria-hidden="true"><span className="block-presence-rail" style={{ background: users[0].color }} /><span className="block-presence-labels">{users.map((user) => <span key={user.userId} style={{ background: user.color }}>{presenceName(user.email)}</span>)}</span></div>;
}
