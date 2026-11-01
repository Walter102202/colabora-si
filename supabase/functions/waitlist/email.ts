// The confirmation a new address receives. The markup is written by hand for mail clients and carries no visitor data.
// Never minify it or run it through an inliner: that breaks the Outlook conditional comments.
const RESEND_EMAILS = 'https://api.resend.com/emails';
const TIMEOUT_MS = 5_000;

const html = `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>You’re on the colabora.si waitlist</title>
<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style>
.e-pad{padding:48px 48px 40px 48px !important}
.e-h1{font-size:40px !important;line-height:44px !important}
</style>
<![endif]-->
<style>
html,body{margin:0;padding:0}
body,table,td,a,p,h1{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
a:hover{text-decoration:underline !important}
@media only screen and (min-width:481px){
.e-gutter{padding:48px 20px !important}
.e-pad{padding:48px 48px 40px 48px !important}
.e-h1{font-size:40px !important;line-height:44px !important}
}
</style>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.e-ground{background-color:#181a1b !important}
.e-sheet{background-color:#212426 !important;border-color:#3c4142 !important}
.e-head{color:#f7f6f1 !important}
.e-ink{color:#eeece5 !important}
.e-blue{color:#88c3f7 !important}
}
</style>
<!--[if !mso]><!-->
<style>
@font-face{font-family:Newsreader;font-style:normal;font-weight:400;font-display:swap;src:url("https://colabora.si/fonts/newsreader-latin.woff2") format("woff2")}
.e-h1{font-family:Newsreader,Georgia,"Times New Roman",Times,serif !important}
</style>
<!--<![endif]-->
</head>
<body class="e-ground" bgcolor="#f7f7f3" style="margin:0;padding:0;background-color:#f7f7f3;">
<div role="article" aria-label="You’re on the colabora.si waitlist" lang="en" dir="ltr">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">We’ll write to you when your invite is ready.&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td class="e-ground e-gutter" align="center" bgcolor="#f7f7f3" style="padding:24px 16px;background-color:#f7f7f3;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td width="560"><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;margin:0 auto;border-collapse:separate;border-spacing:0;">
<tr>
<td class="e-sheet e-pad" align="left" bgcolor="#ffffff" style="padding:32px 24px 24px 24px;background-color:#ffffff;border:1px solid #dfdfd7;border-radius:12px;">
<h1 class="e-h1 e-head" style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',Times,serif;font-size:32px;line-height:36px;font-weight:400;letter-spacing:-1px;color:#1b1a17;mso-line-height-rule:exactly;">You’re on&nbsp;the&nbsp;list.</h1>
<p class="e-ink" style="margin:0 0 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;line-height:27px;font-weight:400;color:#37352f;mso-line-height-rule:exactly;">We’ll write to you when your&nbsp;invite&nbsp;is&nbsp;ready.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
<tr>
<td align="left" valign="bottom" style="padding:0;">
<p style="margin:0;"><a class="e-ink" href="https://colabora.si/" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:21px;line-height:26px;font-weight:700;letter-spacing:-0.5px;color:#37352f;text-decoration:none;white-space:nowrap;mso-line-height-rule:exactly;">colabora<span class="e-blue" style="color:#196eb9;">.si</span></a></p>
</td>
<td width="64" align="right" valign="bottom" style="width:64px;padding:0;font-size:0;line-height:0;">
<img src="https://colabora.si/brand/trama/v1/trama-128.png" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border:0;outline:none;text-decoration:none;">
</td>
</tr>
</table>
</td>
</tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td>
</tr>
</table>
</div>
</body>
</html>
`;

export const WAITLIST_EMAIL = {
  from: 'colabora.si <hello@colabora.si>',
  subject: "You're on the colabora.si waitlist",
  text: "You're on the list.\nWe'll write to you when your invite is ready.\n\ncolabora.si\n",
  html,
};

// The key follows the row, so a retry within Resend's idempotency window never reaches the same person twice.
export async function sendConfirmation(apiKey: string, to: string, id: string, send: typeof fetch = fetch): Promise<void> {
  const { from, subject, text, html } = WAITLIST_EMAIL;
  const res = await send(RESEND_EMAILS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `waitlist/${id}` },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`resend answered ${res.status}`);
}
