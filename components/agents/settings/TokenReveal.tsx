"use client";

import { useState } from "react";

// Shows a freshly issued personal access token exactly once.
export function TokenReveal({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="rounded-md border border-border bg-bg-secondary p-3 text-sm">
      <p className="mb-2 font-medium">Copy this token now. It will not be shown again.</p>
      <code className="block break-all rounded bg-bg px-2 py-1 font-mono text-xs">{token}</code>
      <div className="mt-2 flex gap-2">
        <button type="button" className="rounded border border-border px-2 py-1 text-xs hover:bg-bg" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="rounded px-2 py-1 text-xs text-text-secondary hover:bg-bg" onClick={onDone}>
          I saved it
        </button>
      </div>
    </div>
  );
}
