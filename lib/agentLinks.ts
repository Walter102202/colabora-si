// Deep links of the agent layer, built on lib/routes.ts. The Edge Functions use copies of both modules
// (supabase/functions/_shared/lib/); tests/agents/functionsSharedSync.test.ts keeps them identical.
import { pageUrl, taskUrl } from "@/lib/routes";

export interface LinkTarget {
  page_id: string | null;
  task_id: string | null;
  approval_id: string | null;
  block_id: string | null;
}

export function taskPath(pageId: string, taskId: string): string {
  return taskUrl(pageId, taskId);
}

export function approvalPath(pageId: string, taskId: string, approvalId: string): string {
  return `${taskUrl(pageId, taskId)}#approval-${encodeURIComponent(approvalId)}`;
}

export function notificationPath(n: LinkTarget): string | null {
  if (!n.page_id) return null;
  const path = n.task_id ? taskUrl(n.page_id, n.task_id) : pageUrl(n.page_id);
  const hash = n.approval_id ? `#approval-${encodeURIComponent(n.approval_id)}` : n.block_id ? `#${encodeURIComponent(n.block_id)}` : "";
  return path + hash;
}
