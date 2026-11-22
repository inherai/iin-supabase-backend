// Emails to recruiters about their own work in /talent (agreed 2026-11-22):
//   recruiter_write_to_her · 48 hours after a candidate accepted, when the recruiter hasn't written yet.
//                            Personal (category 'recruiting', never capped). Once per acceptance.
//   recruiter_weekly       · Sunday from 09:00 Israel time, to recruiters who used talent in the last 30 days:
//                            answers this week, outreach waiting, accepted-but-not-written, candidates stuck in a stage.
//                            Only when there is something in it.
//   recruiter_saved_updates· Sunday from 09:00: saved / project candidates who became "looking" or "open to offers"
//                            this week — only those whose status this recruiter may see (visibility 'recruiters',
//                            not working at her own company: talent_hidden_seeking).
// Sunday's two emails go out Sunday–Tuesday (the cap of one nice-to-know email a day spaces them).
// Recruiter copy is gender-neutral; candidates are named by first name only.
import { adminClient } from '../emailPrefs.ts'
import { biColumns, button, esc, heading, paragraph } from '../emailLayout.ts'
import { outOfTime } from './runClock.ts'
import { activeRecruiters, APP_URL, both, DAY, lastTalentUse, layout, list, none, sendTo, stats, type JobResult } from './recruiters.ts'

function israelNow(now: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((x) => [x.type, x.value]))
  return { hour: Number(p.hour), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}
/** The Sunday this week's emails belong to (YYYY-MM-DD). */
const weekKey = (now: Date) => {
  const { weekday } = israelNow(now)
  return new Date(now.getTime() - weekday * DAY).toISOString().slice(0, 10)
}

/** Did the recruiter write to the candidate in chat since `since`? */
async function wroteSince(recruiterId: string, candidateId: string, since: string): Promise<boolean> {
  const db = adminClient()
  const { data: convs } = await db.from('conversations').select('id')
    .or(`and(user1_id.eq.${recruiterId},user2_id.eq.${candidateId}),and(user1_id.eq.${candidateId},user2_id.eq.${recruiterId})`)
  const ids = (convs ?? []).map((c) => c.id)
  if (!ids.length) return false
  const { count } = await db.from('messages').select('id', { count: 'exact', head: true })
    .in('conversation_id', ids).eq('sender_id', recruiterId).gte('created_at', since)
  return (count ?? 0) > 0
}

async function firstNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const { data } = await adminClient().from('users').select('uuid, first_name, is_anonymous').in('uuid', ids)
  return new Map((data ?? []).map((u) => [u.uuid, u.is_anonymous ? '' : (u.first_name ?? '').trim()]))
}

const ago = (ms: number): { he: string; en: string } => {
  const d = Math.max(1, Math.round(ms / DAY))
  return d === 1 ? { he: 'אתמול', en: 'yesterday' } : d === 2 ? { he: 'לפני יומיים', en: 'two days ago' } : { he: `לפני ${d} ימים`, en: `${d} days ago` }
}
const messagesUrl = (candidateId: string) => `${APP_URL()}/innercircle/messages?partnerId=${encodeURIComponent(candidateId)}`

// ───────────────────────── she accepted — write to her ─────────────────────────

export async function writeToHerJob(budget: number, now = new Date()): Promise<JobResult> {
  if (budget <= 0) return none
  const db = adminClient()
  const t = now.getTime()
  const { data: rows } = await db.from('profile_access_requests')
    .select('id, recruiter_id, candidate_id, context_title, contact_accepted_at, status')
    .in('status', ['approved', 'partial']).not('contact_accepted_at', 'is', null)
    .gte('contact_accepted_at', new Date(t - 7 * DAY).toISOString()).lte('contact_accepted_at', new Date(t - 2 * DAY).toISOString())
    .limit(500)
  if (!rows?.length) return none
  const recruiters = new Map((await activeRecruiters()).map((r) => [r.uuid, r]))
  const names = await firstNames(rows.map((r) => r.candidate_id))
  const counts: JobResult = { sent: 0, attempts: 0 }
  for (const q of rows) {
    if (counts.attempts >= budget || outOfTime()) break
    const r = recruiters.get(q.recruiter_id)
    if (!r) continue
    if (await wroteSince(q.recruiter_id, q.candidate_id, q.contact_accepted_at)) continue
    const name = names.get(q.candidate_id) || ''
    const when = ago(t - Date.parse(q.contact_accepted_at))
    const about = (q.context_title ?? '').trim()
    const who = { he: name || 'המועמדת', en: name || 'The candidate' }
    const html = (u: string | null) => layout(biColumns({
      he: heading(`${esc(who.he)} אישרה את הפנייה שלך ${when.he}`) +
        paragraph(`${about ? `הפנייה בנושא <b dir="auto">${esc(about)}</b> אושרה` : 'הפנייה אושרה'}, ועדיין לא נשלחה הודעה. מועמדות עונות הרבה יותר כשכותבים להן בימים הראשונים אחרי האישור.`),
      en: heading(`${esc(who.en)} accepted your outreach ${when.en}`) +
        paragraph(`${about ? `Your outreach about <b dir="auto">${esc(about)}</b> was accepted` : 'Your outreach was accepted'}, and no message has been sent yet. Candidates reply much more often when you write in the first days after they accept.`),
    }) + button({ he: name ? `שליחת הודעה ל${name}` : 'שליחת הודעה', en: name ? `Message ${name}` : 'Send a message' }, messagesUrl(q.candidate_id)),
    { he: 'היא אישרה את הפנייה — הצעד הבא הוא הודעה', en: 'She accepted — the next step is a message' }, u,
    { he: 'קיבלת את המייל כי מועמדת אישרה פנייה שלך בדואולין.', en: 'You received this because a candidate accepted your outreach on duallin.' })
    await sendTo(r, {
      kind: 'recruiter_write_to_her', category: 'recruiting', refKey: `${q.id}:${q.contact_accepted_at}`,
      subject: { he: `${who.he} מחכה להודעה ממך`, en: `${who.en} is waiting for your message` },
      html,
    }, counts)
  }
  return counts
}

// ───────────────────────── the recruiter's week ─────────────────────────

const OPEN_STAGES = ['contacted', 'replied', 'interviewing', 'offer']
const STAGE_NAMES: Record<string, { he: string; en: string }> = {
  contacted: { he: 'נוצר קשר', en: 'Contacted' }, replied: { he: 'ענתה', en: 'Replied' },
  interviewing: { he: 'בראיונות', en: 'Interviewing' }, offer: { he: 'הצעה', en: 'Offer' },
}

export async function weeklySummaryJob(budget: number, now = new Date()): Promise<JobResult> {
  const { weekday, hour } = israelNow(now)
  if (budget <= 0 || weekday > 2 || (weekday === 0 && hour < 9)) return none
  const db = adminClient()
  const t = now.getTime()
  const week = weekKey(now)
  const recruiters = await activeRecruiters()
  if (!recruiters.length) return none
  const ids = recruiters.map((r) => r.uuid)
  const lastUse = await lastTalentUse(ids)
  const active = recruiters.filter((r) => t - (lastUse.get(r.uuid) ?? 0) < 30 * DAY)
  if (!active.length) return none
  const { data: done } = await db.from('email_log').select('user_id').eq('kind', 'recruiter_weekly').eq('ref_key', week)
    .in('user_id', active.map((r) => r.uuid)).in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const told = new Set((done ?? []).map((d) => d.user_id))
  const weekAgo = new Date(t - 7 * DAY).toISOString()
  const counts: JobResult = { sent: 0, attempts: 0 }

  for (const r of active) {
    if (told.has(r.uuid)) continue
    if (counts.attempts >= budget || outOfTime()) break
    const [{ data: reqs }, { data: stuck }] = await Promise.all([
      db.from('profile_access_requests').select('candidate_id, status, contact_accepted_at, updated_at').eq('recruiter_id', r.uuid).limit(1000),
      db.from('talent_project_candidates').select('candidate_id, stage, stage_changed_at, talent_projects(name, archived)')
        .eq('recruiter_id', r.uuid).in('stage', OPEN_STAGES).lt('stage_changed_at', weekAgo).limit(500),
    ])
    const all = reqs ?? []
    const accepted = all.filter((q) => q.contact_accepted_at && q.contact_accepted_at >= weekAgo).length
    const declined = all.filter((q) => q.status === 'rejected' && q.updated_at >= weekAgo).length
    const pending = all.filter((q) => q.status === 'pending').length
    const unwritten: string[] = []
    for (const q of all.filter((q) => ['approved', 'partial'].includes(q.status) && q.contact_accepted_at)) {
      if (!(await wroteSince(r.uuid, q.candidate_id, q.contact_accepted_at!))) unwritten.push(q.candidate_id)
    }
    const stale = (stuck ?? []).filter((s: any) => !s.talent_projects?.archived)
    if (!accepted && !declined && !pending && !unwritten.length && !stale.length) continue

    const names = await firstNames(unwritten.slice(0, 3))
    const todo: { title: { he: string; en: string }; sub: { he: string; en: string }; href: string }[] = []
    for (const id of unwritten.slice(0, 3)) {
      const n = names.get(id) || ''
      todo.push({ title: { he: `${n || 'מועמדת'} אישרה — עוד לא כתבת לה`, en: `${n || 'A candidate'} accepted — no message yet` }, sub: { he: 'הצעד הבא הוא הודעה', en: 'The next step is a message' }, href: messagesUrl(id) })
    }
    // stuck candidates, by project and stage
    const groups = new Map<string, { project: string; stage: string; n: number }>()
    for (const s of stale as any[]) {
      const key = `${s.talent_projects?.name ?? ''}|${s.stage}`
      const g = groups.get(key) ?? { project: s.talent_projects?.name ?? '', stage: s.stage, n: 0 }
      g.n++
      groups.set(key, g)
    }
    for (const g of [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 3)) {
      todo.push({
        title: { he: `${g.n === 1 ? 'מועמדת אחת' : `${g.n} מועמדות`} בשלב "${STAGE_NAMES[g.stage].he}" יותר משבוע`, en: `${g.n} candidate${g.n === 1 ? '' : 's'} in "${STAGE_NAMES[g.stage].en}" for over a week` },
        sub: { he: g.project ? `פרויקט ${g.project}` : 'בפרויקטים שלך', en: g.project ? `Project ${g.project}` : 'In your projects' },
        href: `${APP_URL()}/talent?tab=projects`,
      })
    }
    const tiles = [
      { n: String(accepted), label: { he: 'פניות אושרו השבוע', en: 'accepted this week' } },
      { n: String(pending), label: { he: 'ממתינות לתשובה', en: 'waiting for an answer' } },
      ...(declined ? [{ n: String(declined), label: { he: 'לא המשיכו', en: 'declined' } }] : []),
    ]
    const html = (u: string | null) => layout(biColumns(both((l) =>
      heading(l === 'he' ? 'השבוע שלך בגיוס' : 'Your recruiting week') + stats(tiles, l) +
      (todo.length ? paragraph(l === 'he' ? '<b>מה מחכה לך:</b>' : '<b>Waiting for you:</b>') + list(todo, l) : ''))) +
      button({ he: 'לטאלנט', en: 'Open Talent' }, `${APP_URL()}/talent`),
      { he: todo.length ? `${todo.length} דברים מחכים לך` : 'הסיכום השבועי', en: todo.length ? `${todo.length} things waiting for you` : 'Your weekly summary' }, u,
      { he: 'קיבלת את המייל כי השתמשת בכלי הגיוס של דואולין בחודש האחרון.', en: 'You received this because you used duallin\'s recruiting tools in the last month.' })
    await sendTo(r, {
      kind: 'recruiter_weekly', refKey: week,
      subject: accepted
        ? { he: `השבוע שלך: ${accepted === 1 ? 'פנייה אחת אושרה' : `${accepted} פניות אושרו`}`, en: `Your week: ${accepted} accepted` }
        : { he: 'השבוע שלך בגיוס', en: 'Your recruiting week' },
      html,
    }, counts)
  }
  return counts
}

// ───────────────────────── saved candidates who started looking ─────────────────────────

export async function savedUpdatesJob(budget: number, now = new Date()): Promise<JobResult> {
  const { weekday, hour } = israelNow(now)
  if (budget <= 0 || weekday > 2 || (weekday === 0 && hour < 9)) return none
  const db = adminClient()
  const t = now.getTime()
  const week = weekKey(now)
  const recruiters = await activeRecruiters()
  if (!recruiters.length) return none
  const { data: done } = await db.from('email_log').select('user_id').eq('kind', 'recruiter_saved_updates').eq('ref_key', week)
    .in('user_id', recruiters.map((r) => r.uuid)).in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const told = new Set((done ?? []).map((d) => d.user_id))
  const weekAgo = new Date(t - 7 * DAY).toISOString()
  const counts: JobResult = { sent: 0, attempts: 0 }

  for (const r of recruiters) {
    if (told.has(r.uuid)) continue
    if (counts.attempts >= budget || outOfTime()) break
    const [{ data: saved }, { data: inProjects }] = await Promise.all([
      db.from('saved_resources').select('saved_resource_id').eq('user_id', r.uuid).eq('saved_resource_type', 'candidate').limit(1000),
      db.from('talent_project_candidates').select('candidate_id, talent_projects(name)').eq('recruiter_id', r.uuid).limit(1000),
    ])
    const where = new Map<string, { he: string; en: string }>()
    for (const s of saved ?? []) where.set(s.saved_resource_id, { he: 'שמורה אצלך', en: 'saved' })
    for (const p of (inProjects ?? []) as any[]) {
      if (!where.has(p.candidate_id)) where.set(p.candidate_id, { he: `בפרויקט "${p.talent_projects?.name ?? ''}"`, en: `in project "${p.talent_projects?.name ?? ''}"` })
    }
    const ids = [...where.keys()]
    if (!ids.length) continue
    const { data: changed } = await db.from('member_job_seeking').select('user_uuid, status')
      .in('user_uuid', ids).in('status', ['active', 'open']).eq('visibility', 'recruiters').gte('updated_at', weekAgo)
    if (!changed?.length) continue
    // never tell a recruiter that someone at her own company is looking
    const { data: hidden, error } = await db.rpc('talent_hidden_seeking', { p_viewer: r.uuid, p_ids: changed.map((c) => c.user_uuid) })
    if (error) { console.error('talent_hidden_seeking failed:', error.message); continue }
    const hide = new Set(((hidden ?? []) as any[]).map((x) => (typeof x === 'string' ? x : x?.talent_hidden_seeking)))
    const shown = changed.filter((c) => !hide.has(c.user_uuid)).slice(0, 6)
    if (!shown.length) continue
    const names = await firstNames(shown.map((c) => c.user_uuid))
    const rows = shown.map((c) => {
      const n = names.get(c.user_uuid) || ''
      const w = where.get(c.user_uuid)!
      return {
        title: { he: n || 'מועמדת', en: n || 'A candidate' },
        sub: c.status === 'active'
          ? { he: `עכשיו מחפשת עבודה באופן פעיל · ${w.he}`, en: `Now actively looking · ${w.en}` }
          : { he: `עכשיו פתוחה להצעות · ${w.he}`, en: `Now open to offers · ${w.en}` },
        href: `${APP_URL()}/talent?candidate=${encodeURIComponent(c.user_uuid)}`,
      }
    })
    const html = (u: string | null) => layout(biColumns(both((l) => (l === 'he'
      ? heading('עדכונים על מועמדות ששמרת') + paragraph(shown.length === 1 ? 'השבוע השתנה משהו אצל מועמדת שברשימות שלך:' : `השבוע השתנה משהו אצל ${shown.length} מועמדות שברשימות שלך:`)
      : heading('Updates on your saved candidates') + paragraph(`This week, something changed for ${shown.length === 1 ? 'a candidate' : `${shown.length} candidates`} on your lists:`)) +
      list(rows, l))) + button({ he: 'למועמדות השמורות', en: 'Saved candidates' }, `${APP_URL()}/talent?tab=saved`),
      { he: 'מועמדות מהרשימות שלך פתוחות עכשיו להצעות', en: 'Candidates on your lists are now open to offers' }, u,
      { he: 'קיבלת את המייל כי שמרת מועמדות או הוספת אותן לפרויקט בדואולין.', en: 'You received this because you saved candidates or added them to a project on duallin.' })
    await sendTo(r, {
      kind: 'recruiter_saved_updates', refKey: week,
      subject: shown.length === 1
        ? { he: `${rows[0].title.he} פתוחה עכשיו להצעות`, en: `${rows[0].title.en} is now open to offers` }
        : { he: `${shown.length} מועמדות ששמרת פתוחות עכשיו להצעות`, en: `${shown.length} saved candidates are now open to offers` },
      html,
    }, counts)
  }
  return counts
}
