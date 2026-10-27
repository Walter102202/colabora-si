// Console channel: the default when no chat bot is configured. Writes one line per event.

/**
 * @param {{write?: (line: string) => void}} [opts]
 * @returns {{notify: (event: import("../loop.mjs").ChannelEvent) => void, start: () => Promise<void>}}
 */
export function createConsoleChannel({ write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  return {
    notify(event) {
      write(`[${event.kind}] ${event.text}${event.link ? ` ${event.link}` : ""}`);
    },
    async start() {},
  };
}
