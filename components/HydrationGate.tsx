import { useEffect, useState, type ReactNode } from "react";
import { continueWithoutLocalCopy, hydrateWorkspace, useLocalHealth } from "@/lib/localPersistence";

export const HYDRATE_SLOW_MS = 3000;

export default function HydrationGate({ children }: { children: ReactNode }) {
  const health = useLocalHealth((state) => state.health);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    void hydrateWorkspace();
    const timer = setTimeout(() => setSlow(true), HYDRATE_SLOW_MS);
    return () => clearTimeout(timer);
  }, []);
  if (health !== "starting") return <>{children}</>;
  return <div className="app-shell hydration-skeleton" aria-busy="true">
    <div className="app-sidebar" />
    <main>{slow && <div role="status">
      <p>Opening your local copy is taking longer than usual.</p>
      <button className="action-button" onClick={continueWithoutLocalCopy}>Continue without it</button>
    </div>}</main>
  </div>;
}
