// Browser push services, checked against their documentation on 2026-10-29:
// https://web.dev/articles/push-notifications-server-codelab
// https://mozilla-services.github.io/autopush-rs/
// https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/firewall-allowlist-config
// https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
// Keep paths/query strings opaque: WNS in particular uses query-string tokens.
export function isBrowserPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" ||
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:notify\.windows\.com|push\.apple\.com)$/.test(host);
  } catch {
    return false;
  }
}
