import { useId, useState } from "react";

// Free-text message to the agent. Ctrl+Enter sends.
export function FeedbackComposer({
  disabled,
  placeholder = "Tell the agent what to change or what you decided…",
  onSend,
}: {
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => Promise<void>;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSend(body);
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-message`} className="sr-only">Message to the agent</label>
      <textarea
        id={`${id}-message`}
        className="w-full resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
        rows={2}
        value={text}
        placeholder={placeholder}
        disabled={disabled || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
        }}
      />
      <div className="flex items-center justify-between text-xs text-text-tertiary">
        <span>Ctrl+Enter to send</span>
        <button type="button" className="rounded border border-border px-2 py-1 hover:bg-bg-secondary disabled:opacity-50" disabled={disabled || busy || !text.trim()} onClick={() => void send()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
