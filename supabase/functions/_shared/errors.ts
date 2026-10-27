// JSON responses shared by the Edge Functions. Error bodies use the OAuth shape {error, error_description}.

export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function oauthError(
  status: number,
  code: string,
  description: string,
  headers: HeadersInit = {},
): Response {
  return jsonResponse(status, { error: code, error_description: description }, headers);
}
