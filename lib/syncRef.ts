let copiedKey: string | null = null;
export function setCopiedSyncKey(key: string) { copiedKey = key; }
export function getCopiedSyncKey(): string | null { return copiedKey; }
