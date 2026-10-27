// JSON-RPC 2.0 helpers for the stdio side (newline-delimited JSON) and for
// reading Streamable HTTP responses (plain JSON or Server-Sent Events).

/** Standard JSON-RPC error codes. */
export const JSONRPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * Splits a text stream into lines and calls `onLine` for each non-empty one.
 * @param {(line: string) => void} onLine
 */
export function createLineReader(onLine) {
  let buffer = "";
  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
    },
    end() {
      if (buffer.trim()) onLine(buffer.replace(/\r$/, ""));
      buffer = "";
    },
  };
}

/**
 * Parses one line into a JSON-RPC message (or a batch array).
 * @param {string} line
 * @returns {{ ok: true, message: any } | { ok: false, error: string }}
 */
export function parseMessage(line) {
  try {
    return { ok: true, message: JSON.parse(line) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function errorResponse(id, code, message, data) {
  /** @type {{ code: number, message: string, data?: unknown }} */
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** @param {any} message */
export const isRequest = (message) =>
  !!message && typeof message === "object" && typeof message.method === "string" && message.id !== undefined && message.id !== null;

/** @param {any} message */
export const isNotification = (message) =>
  !!message && typeof message === "object" && typeof message.method === "string" && (message.id === undefined || message.id === null);

/** @param {any} message */
export const isResponse = (message) =>
  !!message && typeof message === "object" && message.method === undefined && ("result" in message || "error" in message);

/**
 * Incremental Server-Sent Events parser: calls `onData` with the joined
 * `data:` lines of each event.
 * @param {(data: string) => void} onData
 */
export function createSseParser(onData) {
  let buffer = "";
  /** @type {string[]} */
  let data = [];
  const flushEvent = () => {
    if (data.length) onData(data.join("\n"));
    data = [];
  };
  /** @param {string} line */
  const handleLine = (line) => {
    if (line === "") return flushEvent();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  };
  return {
    /** @param {string} chunk */
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(buffer[index] === "\r" ? index + 2 : index + 1);
        handleLine(line);
      }
    },
    end() {
      if (buffer) handleLine(buffer);
      buffer = "";
      flushEvent();
    },
  };
}
