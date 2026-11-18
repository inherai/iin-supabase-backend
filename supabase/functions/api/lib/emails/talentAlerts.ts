// H3 · talent_alert — to a recruiter, once a week (Sunday from 09:00 Israel time): new candidates
// who match her saved searches. One e-mail for all her saved searches, only when at least one has
// someone new; otherwise nothing. Counts and the search names only — no candidate details in the
// e-mail (the site shows them, under the usual privacy rules).
//
// Only searches built from filters are checked: a free-text or job-match search would need an
// AI call per search every week. Those are still listed in the site, just not e-mailed.
// "New" = became an active member since the previous alert (at most 14 days back).
// Recruiter copy is gender-neutral (product rule for recruiters).
import { adminClient } from '../emailPrefs.ts'
import { sendEmail } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout } from '../emailLayout.ts'
import { outOfTime } from './runClock.ts'
import { filterParams, hasFilterParams } from '../../routes/_talentProfiles.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const DAY = 24 * 3600 * 1000
const MAX_SEARCHES_PER_RECRUITER = 10
type JobResult = { sent: number; attempts: number }
const none: JobResult = { sent: 0, attempts: 0 }

function israelNow(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).map((x) => [x.type, x.value]))
  return { hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), date: `${p.year}-${p.month}-${p.day}` }
}

export interface TalentAlertItem { searchId: string; name: string; count: number }

const countLine = (n: number) => (n === 1
  ? { he: 'מועמדת חדשה אחת', en: '1 new candidate' }
  : n === 2 ? { he: '2 מועמדות חדשות', en: '2 new candidates' } : { he: `${n} מועמדות חדשות`, en: `${n} new candidates` })

export function renderTalentAlert(items: TalentAlertItem[], unsubscribeUrl: string | null): string {
  const total = items.reduce((a, b) => a + b.count, 0)
  const list = (lang: 'he' | 'en') => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${lang === 'he' ? 'rtl' : 'ltr'}" style="margin:4px 0 10px;">` +
    items.map((i) => `<tr><td style="padding:8px 0;border-top:1px solid #ece7ef;font-family:Arial,sans-serif;font-size:14px;text-align:${lang === 'he' ? 'right' : 'left'};">
      <a href="${APP_URL()}/talent?saved=${encodeURIComponent(i.searchId)}" style="color:#3d1240;font-weight:700;text-decoration:none;"><span dir="auto">${esc(i.name)}</span></a><br>
      <span style="color:#6b5a78;font-size:13px;">${countLine(i.count)[lang]}</span></td></tr>`).join('') + '</table>'
  const body = biColumns({
    he: heading(total === 1 ? 'מועמדת חדשה מתאימה לחיפושים השמורים שלך' : `${total} מועמדות חדשות מתאימות לחיפושים השמורים שלך`) +
      paragraph('מאז העדכון הקודם הצטרפו לדואולין מועמדות שעונות על החיפושים ששמרת:') + list('he'),
    en: heading(total === 1 ? 'A new candidate matches your saved searches' : `${total} new candidates match your saved searches`) +
      paragraph('Since the last update, candidates who match your saved searches joined duallin:') + list('en'),
  }) + button({ he: 'לצפייה במועמדות', en: 'See the candidates' }, `${APP_URL()}/talent?saved=${encodeURIComponent(items[0].searchId)}`)
  return renderLayout({
    preheader: { he: 'מועמדות חדשות לחיפושים השמורים שלך', en: 'New candidates for your saved searches' },
    body,
    reason: { he: 'קיבלת את המייל כי שמרת חיפושי מועמדות בדואולין. אפשר למחוק חיפוש שמור כדי להפסיק לקבל עליו עדכונים.', en: 'You received this because you saved candidate searches on duallin. Delete a saved search to stop its updates.' },
    unsubscribeUrl,
  })
}

export async function talentAlertJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const { hour, weekday, date } = israelNow(now)
  if (weekday !== 0 || hour < 9) return none
  const db = adminClient()

  const { data: searches } = await db.from('saved_talent_searches')
    .select('id, recruiter_id, name, filters, created_at').order('created_at', { ascending: false }).limit(5000)
  if (!searches?.length) return none

  // Free text and job matches are left out (they need an AI call); empty searches too.
  const byRecruiter = new Map<string, typeof searches>()
  for (const s of searches) {
    const f = s.filters ?? {}
    if ((f.searchQuery ?? '').trim() || (f.jdMode && f.jdMode !== 'none')) continue
    if (!hasFilterParams(filterParams(f))) continue
    const list = byRecruiter.get(s.recruiter_id) ?? []
    if (list.length < MAX_SEARCHES_PER_RECRUITER) list.push(s)
    byRecruiter.set(s.recruiter_id, list)
  }
  if (!byRecruiter.size) return none

  const ids = [...byRecruiter.keys()]
  const [{ data: users }, { data: sentBefore }] = await Promise.all([
    db.from('users').select('uuid, email, role, status').in('uuid', ids),
    db.from('email_log').select('user_id, created_at').eq('kind', 'talent_alert').in('status', ['sent', 'delivered'])
      .in('user_id', ids).gte('created_at', new Date(now.getTime() - 14 * DAY).toISOString()),
  ])
  const lastSent = new Map<string, number>()
  for (const r of sentBefore ?? []) lastSent.set(r.user_id, Math.max(lastSent.get(r.user_id) ?? 0, Date.parse(r.created_at)))

  let attempts = 0
  let sent = 0
  for (const u of users ?? []) {
    if (attempts >= budget || outOfTime()) break
    if (!u.email || u.status !== 'Active' || u.role !== 'recruiters') continue
    const since = new Date(Math.max(lastSent.get(u.uuid) ?? 0, now.getTime() - 7 * DAY))
    const items: TalentAlertItem[] = []
    for (const s of byRecruiter.get(u.uuid) ?? []) {
      if (outOfTime()) break
      // a search saved after `since` only counts members who joined after it was saved
      const after = new Date(Math.max(since.getTime(), Date.parse(s.created_at)))
      const { data } = await db.rpc('talent_search', {
        p_viewer: u.uuid, ...filterParams(s.filters ?? {}), p_joined_after: after.toISOString(), p_sort: 'recent', p_limit: 1,
      })
      const count = Number((data as any[] | null)?.[0]?.total_count ?? 0)
      if (count > 0) items.push({ searchId: s.id, name: s.name, count })
    }
    if (!items.length) continue
    items.sort((a, b) => b.count - a.count)
    const total = items.reduce((a, b) => a + b.count, 0)
    attempts++
    const res = await sendEmail({
      kind: 'talent_alert', category: 'recruiting', to: u.email, userId: u.uuid, refKey: `talent_alert:${date}`,
      subject: total === 1
        ? 'מועמדת חדשה לחיפוש השמור שלך | A new candidate for your saved search'
        : `${total} מועמדות חדשות לחיפושים השמורים שלך | ${total} new candidates for your saved searches`,
      html: ({ unsubscribeUrl }) => renderTalentAlert(items, unsubscribeUrl),
    })
    if (res.status === 'deferred') attempts--
    if (res.status === 'sent') sent++
  }
  return { sent, attempts }
}
