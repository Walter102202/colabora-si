import { useRef, useState } from "react";

interface Choice<T> {
  value: T;
  save: (value: T) => Promise<void>;
}

// A control that saves on every change (a select, a radio group) and stays enabled while it saves, so the
// keyboard focus never drops to the page: one call at a time, and a choice made meanwhile is sent when the
// call returns (only the latest one, and not again when it is what was just saved). `pending` is the choice
// on screen until the saves settle; `busy` goes to aria-busy. Each choice keeps the save it was made with.
export function useQueuedChoice<T>() {
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<Choice<T> | null>(null);
  const running = useRef(false);

  const choose = async (value: T, save: (value: T) => Promise<void>) => {
    latest.current = { value, save };
    setPending({ value });
    if (running.current) return;
    running.current = true;
    setError(null);
    try {
      let next: Choice<T> | null = latest.current;
      while (next) {
        const sent: Choice<T> = next;
        await sent.save(sent.value);
        next = latest.current === sent || Object.is(latest.current?.value, sent.value) ? null : latest.current;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      latest.current = null;
      setPending(null);
    }
  };

  return { pending, busy: pending !== null, error, choose };
}
