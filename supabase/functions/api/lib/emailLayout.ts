// Base template for every system email (email plan: "תבנית הבסיס").
// LinkedIn-style: one white card, the square logo on top, Hebrew and English side by side
// (Hebrew on the right; the columns stack on narrow screens), one main button, and the text
// logo + "why you got this" + settings / stop links in the footer.
// Table-based with inline styles so Gmail and Outlook render it.

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const BRAND = '#4b154c'
const INK = '#1d1d1f'
const INK_2 = '#4a4a50'
const INK_3 = '#86838b'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface Bi { he: string; en: string }

/**
 * Two columns: Hebrew (right, RTL) and English (left, LTR). Values are trusted HTML.
 * Hebrew comes first in the source (an RTL table puts it on the right), so on phones,
 * where the columns stack, Hebrew is on top.
 */
export function biColumns(c: Bi, opts: { tight?: boolean } = {}): string {
  // tight: inside a list or box — on phones, no divider line between the Hebrew and the English
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bi${opts.tight ? ' bi-tight' : ''}" dir="rtl"><tr>
    <td class="bi-he" width="50%" valign="top" dir="rtl" style="padding:0 0 0 16px;border-left:1px solid ${LINE};text-align:right;">${c.he}</td>
    <td class="bi-en" width="50%" valign="top" dir="ltr" style="padding:0 16px 0 0;text-align:left;">${c.en}</td>
  </tr></table>`
}

export const heading = (text: string) =>
  `<h1 style="margin:0 0 8px;font-size:19px;line-height:1.3;font-weight:800;color:${INK};font-family:${FONT};">${text}</h1>`

export const paragraph = (text: string) =>
  `<p style="margin:0 0 8px;font-size:14px;line-height:1.65;color:${INK_2};font-family:${FONT};">${text}</p>`

/** Main call to action, both languages on one button. */
export function button(label: Bi, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:8px auto 0;"><tr>
    <td style="border-radius:999px;background:${BRAND};">
      <a href="${esc(url)}" dir="rtl" style="display:inline-block;padding:12px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">
        <span dir="rtl">${label.he}</span>&nbsp;<span style="opacity:.55;">|</span>&nbsp;<span dir="ltr">${label.en}</span>
      </a>
    </td></tr></table>`
}

export interface LayoutOptions {
  /** Short text shown next to the subject in the inbox. */
  preheader: Bi
  /** Card content (use biColumns / heading / paragraph / button). */
  body: string
  /** Footer: why she got it. */
  reason: Bi
  /** Footer links — omitted for emails that can't be turned off. */
  unsubscribeUrl?: string | null
  showSettingsLink?: boolean
}

export function renderLayout(o: LayoutOptions): string {
  const app = APP_URL()
  const links = o.unsubscribeUrl
    ? `<br><a href="${app}/settings/notifications" style="color:${INK_2};text-decoration:underline;">הגדרות מייל</a>
       &nbsp;·&nbsp;<a href="${esc(o.unsubscribeUrl)}" style="color:${INK_2};text-decoration:underline;">לא לקבל מיילים מסוג זה</a>
       &nbsp;·&nbsp;<a href="${app}/settings/notifications" style="color:${INK_2};text-decoration:underline;">Email settings</a>
       &nbsp;·&nbsp;<a href="${esc(o.unsubscribeUrl)}" style="color:${INK_2};text-decoration:underline;">Unsubscribe</a>`
    : o.showSettingsLink
      ? `<br><a href="${app}/settings/notifications" style="color:${INK_2};text-decoration:underline;">הגדרות מייל · Email settings</a>`
      : ''
  return `<!DOCTYPE html>
<html lang="he"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<style>
  @media (max-width:560px){ .bi td{display:block!important;width:100%!important;padding:0!important;border:0!important;}
    .bi .bi-he{padding-bottom:12px!important;} .bi .bi-en{border-top:1px solid ${LINE}!important;padding-top:10px!important;}
    .bi-tight .bi-he{padding-bottom:6px!important;} .bi-tight .bi-en{border-top:0!important;padding-top:0!important;} }
</style></head>
<body style="margin:0;padding:0;background:#f7f0fa;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${o.preheader.he} · ${o.preheader.en}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f0fa;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:12px;">
        <tr><td style="padding:14px 24px;border-bottom:1px solid ${LINE};" align="right">
          <img src="${app}/logosquare.png" width="34" height="34" alt="duallin" style="display:block;border-radius:8px;">
        </td></tr>
        <tr><td style="padding:22px 24px 8px;">${o.body}</td></tr>
        <tr><td align="center" style="padding:16px 24px 22px;border-top:1px solid ${LINE};">
          <img src="${app}/logotext.png" width="108" alt="duallin" style="display:block;margin:0 auto 6px;opacity:.85;">
          <span style="font-family:${FONT};font-size:11.5px;color:${INK_3};" dir="ltr">Do all in. Together.</span>
        </td></tr>
      </table>
      <p style="max-width:560px;margin:14px auto 0;font-family:${FONT};font-size:11.5px;line-height:1.75;color:${INK_3};text-align:center;">
        <span dir="rtl">${o.reason.he}</span><br><span dir="ltr">${o.reason.en}</span>${links}
      </p>
    </td></tr>
  </table>
</body></html>`
}
