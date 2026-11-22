// The talent spotlight (agreed 2026-11-22): every two weeks, up to three members and the work they
// did lately, picked by the team in /dualldmin/spotlight (talent_spotlight_picks).
//   recruiter_spotlight · Sunday–Tuesday from 10:00 Israel time, to every active recruiter, for the
//                         picks whose send_on is in the last few days.
//   spotlight_featured  · then, to each featured member: "your work was shown to recruiters" — what was
//                         shown, and where to turn it off (talent_spotlight_optouts, in email settings).
// Only work recruiters can already see in the site is suggested (admin_spotlight_suggestions), and
// a member who opted out after being picked is left out. Members are named by first name only.
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { outOfTime } from './runClock.ts'
import { activeRecruiters, APP_URL, both, DAY, layout, ltr, none, sendTo, type JobResult } from './recruiters.ts'

type Kind = 'article' | 'project' | 'post' | 'answer' | 'milestone'
const KIND: Record<Kind, { label: Bi; mine: Bi }> = {
  article: { label: { he: 'פרסמה מאמר', en: 'Published an article' }, mine: { he: 'המאמר שלך', en: 'your article' } },
  project: { label: { he: 'השיקה פרויקט', en: 'Launched a project' }, mine: { he: 'הפרויקט שלך', en: 'your project' } },
  post: { label: { he: 'כתבה בקהילה', en: 'Wrote in the community' }, mine: { he: 'הפוסט שלך', en: 'your post' } },
  answer: { label: { he: 'ענתה על שאלה מקצועית', en: 'Answered a technical question' }, mine: { he: 'התשובה שלך', en: 'your answer' } },
  milestone: { label: { he: 'שיתפה הישג', en: 'Shared a milestone' }, mine: { he: 'ההישג ששיתפת', en: 'the milestone you shared' } },
}

interface Pick {
  id: string; send_on: string; member_uuid: string; kind: Kind
  role_he: string | null; role_en: string | null; did_he: string; did_en: string
  skills: string[]; source_url: string | null; status: string; sent_at: string | null; member_notified_at: string | null
}
interface Member { uuid: string; email: string | null; first_name: string | null; status: string; is_anonymous: boolean | null }

const israelDate = (now: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now)
function israelNow(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((x) => [x.type, x.value]))
  return { hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}
const abs = (url: string | null) => (!url ? null : url.startsWith('http') ? url : `${APP_URL()}${url.startsWith('/') ? '' : '/'}${url}`)

/** One candidate's card: what she did, her role, skills, and links. Everything written by the team, escaped. */
function card(p: Pick, name: string, lang: 'he' | 'en'): string {
  const rtl = lang === 'he'
  const role = (rtl ? p.role_he : p.role_en) ?? ''
  const read = abs(p.source_url)
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${rtl ? 'rtl' : 'ltr'}" style="margin:0 0 12px;border:1px solid #ece7ef;border-radius:10px;background:#fdfbfe;">
    <tr><td style="padding:12px 14px;font-family:Arial,sans-serif;text-align:${rtl ? 'right' : 'left'};">
      <div style="font-size:11px;font-weight:700;letter-spacing:.3px;color:#8a4f8f;">${KIND[p.kind].label[lang]}</div>
      <div style="font-size:15px;font-weight:700;color:#3d1240;margin-top:3px;"><span dir="auto">${esc(name)}</span>${role ? ` · <span style="font-weight:400;color:#4a3a55;">${role.split(' · ').map((x) => `<span dir="auto">${esc(x)}</span>`).join(' · ')}</span>` : ''}</div>
      <div style="font-size:14px;color:#2b2233;line-height:1.55;margin-top:6px;">${rtl ? ltr(esc(p.did_he)) : esc(p.did_en)}</div>
      ${p.skills.length ? `<div style="margin-top:8px;" dir="ltr">${p.skills.map((s) => `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 8px;border-radius:999px;background:#f1e8f5;color:#5b2a60;font-size:12px;">${esc(s)}</span>`).join('')}</div>` : ''}
      <div style="margin-top:6px;font-size:13px;">
        <a href="${APP_URL()}/talent?candidate=${encodeURIComponent(p.member_uuid)}" style="font-weight:700;color:#3d1240;">${rtl ? 'לכרטיס המועמדת ←' : 'View candidate →'}</a>
        ${read ? `&nbsp;·&nbsp;<a href="${esc(read)}" style="color:#6b5a78;">${rtl ? 'לקריאה' : 'Read it'}</a>` : ''}
      </div>
    </td></tr>
  </table>`
}

export function renderSpotlight(items: { pick: Pick; name: string }[], unsub: string | null): { subject: Bi; html: string } {
  const n = items.length
  const fields = [...new Set(items.flatMap((i) => i.pick.skills.slice(0, 1)))].slice(0, 3)
  const title: Bi = n === 1 ? { he: 'מועמדת ששווה להכיר', en: 'A candidate worth knowing' }
    : n === 2 ? { he: 'שתי מועמדות ששווה להכיר', en: 'Two candidates worth knowing' }
    : { he: 'שלוש מועמדות ששווה להכיר', en: 'Three candidates worth knowing' }
  const body = biColumns(both((l) => heading(title[l]) +
    paragraph(l === 'he'
      ? 'מה שהן עשו לאחרונה בקהילת דואולין — עבודה אמיתית, לא רק שורות בקורות חיים.'
      : 'What they did lately in the duallin community — real work, not just CV lines.') +
    items.map((i) => card(i.pick, i.name, l)).join('')))
    + button({ he: 'לחיפוש מועמדות', en: 'Search candidates' }, `${APP_URL()}/talent`)
  return {
    subject: { he: `${title.he}${fields.length ? `: ${fields.join(', ')}` : ''}`, en: `${title.en}${fields.length ? `: ${fields.join(', ')}` : ''}` },
    html: layout(body, { he: items.map((i) => KIND[i.pick.kind].label.he).join(' · '), en: items.map((i) => KIND[i.pick.kind].label.en).join(' · ') }, unsub,
      { he: 'קיבלת את המייל כי יש לך גישה לכלי הגיוס של דואולין. מוצג כאן רק תוכן שמגייסים כבר יכולים לראות בדואולין.', en: 'You received this because you have access to duallin\'s recruiting tools. Only content recruiters can already see on duallin is shown here.' }),
  }
}

export function renderFeatured(pick: Pick, firstName: string, unsub: string | null): string {
  const mine = KIND[pick.kind].mine
  const settings = `${APP_URL()}/settings/notifications`
  const body = biColumns({
    he: heading(firstName ? `${esc(firstName)}, העבודה שלך הוצגה למגייסים` : 'העבודה שלך הוצגה למגייסים') +
      paragraph(`השבוע הצגנו את ${mine.he} במייל "מועמדות ששווה להכיר" שנשלח למגייסים בדואולין — עם השם הפרטי שלך בלבד. כך זה הופיע:`) +
      `<div style="padding:10px 12px;background:#faf6fc;border-right:3px solid #8a4f8f;font-family:Arial,sans-serif;font-size:14px;color:#2b2233;line-height:1.55;">${ltr(esc(pick.did_he))}</div>` +
      paragraph('מגייסים שיתעניינו יוכלו לשלוח לך פנייה, ואת מחליטה אם לענות.') +
      paragraph('לא רוצה שהתוכן שלך יוצג למגייסים? אפשר לכבות את זה בהגדרות המייל.'),
    en: heading(firstName ? `${esc(firstName)}, your work was shown to recruiters` : 'Your work was shown to recruiters') +
      paragraph(`This week we showed ${mine.en} in the "candidates worth knowing" email to recruiters on duallin — with your first name only. This is how it appeared:`) +
      `<div style="padding:10px 12px;background:#faf6fc;border-left:3px solid #8a4f8f;font-family:Arial,sans-serif;font-size:14px;color:#2b2233;line-height:1.55;">${esc(pick.did_en)}</div>` +
      paragraph('Recruiters who are interested can send you an outreach, and you decide whether to answer.') +
      paragraph('Prefer your work not to be shown to recruiters? Turn it off in your email settings.'),
  }) + button({ he: 'להגדרות', en: 'Settings' }, settings)
  return renderLayout({
    preheader: { he: 'הצגנו את העבודה שלך במייל למגייסים', en: 'We showed your work in an email to recruiters' },
    body,
    reason: { he: 'קיבלת את המייל כי התוכן שלך הוצג במייל למגייסים בדואולין.', en: 'You received this because your work was shown in an email to recruiters on duallin.' },
    unsubscribeUrl: unsub,
  })
}

/** The picks that go out now: the latest send_on in the last 3 days, members still eligible. */
async function duePicks(now: Date): Promise<{ sendOn: string; items: { pick: Pick; name: string }[] } | null> {
  const db = adminClient()
  const today = israelDate(now)
  const from = israelDate(new Date(now.getTime() - 3 * DAY))
  // 'sent' too: the rest of the recruiters still get the picks that already went out to some of them
  const { data } = await db.from('talent_spotlight_picks').select('*').in('status', ['approved', 'sent']).gte('send_on', from).lte('send_on', today)
    .order('send_on', { ascending: false }).order('created_at').limit(10)
  const picks = (data ?? []) as Pick[]
  if (!picks.length) return null
  const sendOn = picks[0].send_on
  const these = picks.filter((p) => p.send_on === sendOn).slice(0, 3)
  const ids = these.map((p) => p.member_uuid)
  const [{ data: members }, { data: optouts }] = await Promise.all([
    db.from('users').select('uuid, email, first_name, status, is_anonymous').in('uuid', ids),
    db.from('talent_spotlight_optouts').select('user_uuid').in('user_uuid', ids),
  ])
  const out = new Set((optouts ?? []).map((o) => o.user_uuid))
  const byId = new Map(((members ?? []) as Member[]).map((m) => [m.uuid, m]))
  const items = these.flatMap((pick) => {
    const m = byId.get(pick.member_uuid)
    if (!m || m.status !== 'Active' || m.is_anonymous || out.has(m.uuid)) return []
    return [{ pick, name: (m.first_name ?? '').trim() }]
  }).filter((i) => i.name)
  return items.length ? { sendOn, items } : null
}

export async function spotlightJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const counts: JobResult = { sent: 0, attempts: 0 }
  const { weekday, hour } = israelNow(now)

  if (weekday <= 2 && hour >= 10) {
    const due = await duePicks(now)
    if (due) {
      const recruiters = await activeRecruiters()
      const { data: done } = await db.from('email_log').select('user_id').eq('kind', 'recruiter_spotlight').eq('ref_key', due.sendOn)
        .in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped']).limit(5000)
      const told = new Set((done ?? []).map((d) => d.user_id))
      const todo = recruiters.filter((r) => !told.has(r.uuid))
      const subject = renderSpotlight(due.items, null).subject
      for (const r of todo) {
        if (counts.attempts >= budget || outOfTime()) break
        const res = await sendTo(r, { kind: 'recruiter_spotlight', refKey: due.sendOn, subject, html: (u) => renderSpotlight(due.items, u).html }, counts)
        if (res.status === 'sent' || res.status === 'skipped') told.add(r.uuid)
      }
      // once it reached a recruiter, the picks are sent: no more edits, and the featured members are told next
      if (told.size) {
        await db.from('talent_spotlight_picks').update({ status: 'sent', sent_at: new Date().toISOString() })
          .in('id', due.items.map((i) => i.pick.id)).eq('status', 'approved')
      }
    }
  }

  // Tell each featured member (nice-to-know: may wait a day for the cap; a week at most).
  const { data: sent } = await db.from('talent_spotlight_picks').select('*').eq('status', 'sent').is('member_notified_at', null)
    .gte('sent_at', new Date(now.getTime() - 7 * DAY).toISOString()).limit(20)
  for (const pick of (sent ?? []) as Pick[]) {
    if (counts.attempts >= budget || outOfTime()) break
    const { data: m } = await db.from('users').select('uuid, email, first_name, status').eq('uuid', pick.member_uuid).maybeSingle()
    if (!m?.email) { await db.from('talent_spotlight_picks').update({ member_notified_at: new Date().toISOString() }).eq('id', pick.id); continue }
    counts.attempts++
    const res = await sendEmail({
      kind: 'spotlight_featured', category: 'content_activity', to: m.email, userId: m.uuid, refKey: pick.send_on,
      subject: 'העבודה שלך הוצגה למגייסים | Your work was shown to recruiters',
      html: ({ unsubscribeUrl }) => renderFeatured(pick, (m.first_name ?? '').trim(), unsubscribeUrl),
    })
    if (res.status === 'deferred') { counts.attempts--; continue }
    if (res.status === 'sent') counts.sent++
    await db.from('talent_spotlight_picks').update({ member_notified_at: new Date().toISOString() }).eq('id', pick.id)
  }
  return counts
}
