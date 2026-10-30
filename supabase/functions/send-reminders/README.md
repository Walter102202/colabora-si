# Push delivery

Apply migration 0023 before deploying this function. Its service-role-only RPCs
select at most 200 rows per queue and 20 per person, in rounds. Each pass gives
people a fresh random priority, so more than 200 people do not leave the same
people permanently at the back. Multiple devices do not multiply a person's quota.

Reminders need a subscription and must be due by at most 24 hours. Older or
unsubscribed reminders retain `notified = false` for the in-app reminder checker.
Only successful push delivery sets it to true. Agent notifications use their own
`pushed_at`: the batch RPC expires rows older than 24 hours in one update before
selecting fresh rows. The handler still settles decided approvals and rows without
subscriptions, without affecting the inbox or its read state.

Reminder marking and subscription pruning pass opaque text arrays in RPC bodies.
The response's `notified` counts reminder rows changed to `notified = true`, and
`removed` counts deleted subscriptions. Neither counts attempted writes or agent
notifications (`pushed_at`); `sent` counts successful device deliveries.

Before encryption or network access, delivery validates HTTPS, the default port,
no credentials or fragment, and these browser push hosts:

- `fcm.googleapis.com`: [Google](https://web.dev/articles/push-notifications-server-codelab).
- `updates.push.services.mozilla.com`: [Mozilla](https://mozilla-services.github.io/autopush-rs/).
- Subdomains of `notify.windows.com`: [Microsoft's CloudServiceDNS list](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/firewall-allowlist-config).
- Subdomains of `push.apple.com`: [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

Verified on 2026-10-29. Paths and query strings are opaque provider tokens.
Redirects are never followed. Disallowed endpoints and malformed keys are pruned
like expired subscriptions; failed reminders remain available in the app. The
browser uses the same validator before registration, but delivery is the security
boundary because authenticated users can write subscriptions through the API.

## Local capture

The review harness can run this handler in local Deno and capture encrypted POSTs
at an exact loopback origin. Set the following in the harness process environment:

```dotenv
SUPABASE_URL=http://127.0.0.1:60721
PUSH_LOCAL_CAPTURE_ORIGIN=http://127.0.0.1:60727
```

Also provide the local service-role key. Capture requires an HTTP local Supabase
host (`127.0.0.1`, `localhost`, or Docker's `kong`), no `DENO_DEPLOYMENT_ID`, and
an exact origin match on `http://127.0.0.1`. It is off by default. Request headers,
request bodies and database values cannot enable it. A hosted Supabase URL or
deployment ID disables it even if the capture variable was accidentally set.
Loopback refers to the function's own runtime, so a host capture server should
use a host Deno harness rather than the Docker Edge runtime.

Track A can document the optional variable in `supabase/functions/.env.example`:

```dotenv
PUSH_LOCAL_CAPTURE_ORIGIN=
```

Keep it empty in deployments. No new production configuration is required.
