export const KNOWN_ACTIONS = ["send_email", "publish_page", "http_request", "payment"] as const;

const truncate = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function summarizeParams(params: Record<string, unknown>, max = 120): string {
  const parts = Object.entries(params).filter(([, value]) => value !== null && value !== undefined).slice(0, 4).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: (${value.length} items)`;
    if (typeof value === "object") return `${key}: {…}`;
    return `${key}: ${typeof value === "string" ? truncate(value, 40) : String(value)}`;
  });
  return truncate(parts.join(", "), max);
}

const textOr = (value: unknown, missing: string) => value === null || value === undefined || value === "" ? missing : String(value);

export function describeApproval(action: string | null, params: Record<string, unknown>, opts: { artifactVersion?: number | null } = {}): { what: string; effect: string } {
  let what: string;
  let effect: string;
  switch (action) {
    case "send_email": {
      const to = Array.isArray(params.to) ? params.to.join(", ") : params.to;
      const subject = typeof params.subject === "string" && params.subject ? ` with subject "${params.subject}"` : "";
      what = `Send an email to ${textOr(to, "(recipient missing)")}${subject}`;
      effect = "The email leaves the workspace and cannot be recalled.";
      break;
    }
    case "publish_page":
      what = `Publish page ${textOr(params.page_id, "(page missing)")}`;
      effect = "Anyone with the link can read it until it is unpublished.";
      break;
    case "http_request":
      what = `Call ${textOr(params.method, "POST").toUpperCase()} ${textOr(params.url, "(url missing)")}`;
      effect = "The request runs once against an external service.";
      break;
    case "payment":
      what = `Pay ${textOr(params.amount, "(amount missing)")} ${textOr(params.currency, "(currency missing)")} to ${textOr(params.to, "(payee missing)")}`;
      effect = "Money moves and cannot be reversed from here.";
      break;
    default: {
      const summary = summarizeParams(params);
      what = action ? `Run ${action}${summary ? ` with ${summary}` : ""}` : "Run the requested action";
      effect = "Runs exactly once outside the workspace and cannot be undone from here.";
    }
  }
  if (typeof opts.artifactVersion === "number") what += ` for deliverable v${opts.artifactVersion}`;
  return { what, effect };
}
