// B4 · Welcome — once, when a member finishes onboarding (status onboarding → Active).
// A reply to what she just did, so it goes out at once from PUT /me/status at any hour,
// Shabbat included (immediate). The hourly job (welcomeJob) only retries one that failed. Copy comes from the site's he/en.json
// (onboarding.welcome.*, profileStrength.*).
import { adminClient } from '../emailPrefs.ts'
import { sendEmail, type SendResult } from '../mailer.ts'
import { biColumns, button, esc, heading, paragraph, renderLayout, type Bi } from '../emailLayout.ts'
import { calculateProfileStrength } from '../../routes/_scoreHelpers.ts'

const APP_URL = () => Deno.env.get('APP_URL') ?? 'https://www.duallin.com'
const BRAND = '#4b154c'
const LINE = '#ede0f0'
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`
const INVITE_UNLOCK_PCT = 70
/** How long after activation the hourly job still sends a welcome that couldn't go out at once. */
const CATCH_UP_DAYS = 3

const FEATURES: Array<{ he: [string, string]; en: [string, string] }> = [
  { he: ['קהילה שנבנתה עבורך', 'התחברי לעמיתות ומנטוריות שמבינות את המסע שלך ויכולות ללכת איתך בו.'],
    en: ['A Community of Your Own', 'Connect with peers, mentors, and role models who understand your journey.'] },
  { he: ['הזדמנויות תעסוקה', 'חשיפה לאלפי משרות עם ראיית ההתאמה מכל הזוויות - מה שנכון לך, לא רק מה שפתוח.'],
    en: ['Career Opportunities', 'Jobs at companies that genuinely embrace Orthodox women in tech.'] },
  { he: ['ידע וצמיחה', 'למדי מנשים שהלכו בדרך הזו לפנייך.'],
    en: ['Knowledge &amp; Growth', 'Learn from women who have walked the path before you.'] },
  { he: ['פרטיות קודמת', 'שליטה מלאה על הנראות שלך - מציבורית עד אנונימית לחלוטין.'],
    en: ['Privacy First', 'Full control over your visibility - public to fully anonymous.'] },
]

const TIER: Record<string, Bi> = {
  Starter: { he: 'מתחילה', en: 'Starter' },
  Building: { he: 'בונה', en: 'Building' },
  Strong: { he: 'מבוססת', en: 'Strong' },
  Expert: { he: 'מקצועית', en: 'Expert' },
  Elite: { he: 'עילית', en: 'Elite' },
}

// profileStrength.items.* — `partial` = the "expand" wording for a section she started.
const TIPS: Record<string, { full: [Bi, Bi]; partial?: [Bi, Bi] }> = {
  experience: {
    full: [{ he: 'ניסיון עבודה', en: 'Work experience' }, { he: 'הדבר הראשון שמגייסים מחפשים בסינון מועמדים', en: 'The first thing recruiters look for when filtering candidates' }],
    partial: [{ he: 'הוסיפי תיאור לתפקידים שלך', en: 'Add descriptions to your roles' }, { he: 'יש לך תפקידים אבל בלי תיאור - מגייסות רוצות לדעת מה עשית בפועל', en: 'You have roles but no descriptions - recruiters want to know what you actually did' }],
  },
  skills: {
    full: [{ he: 'כישורים', en: 'Skills' }, { he: 'מגייסים מחפשים לפי כישורים - ככל שתוסיפי יותר, כך ייטב', en: 'Recruiters search by skills - the more you add, the better' }],
    partial: [{ he: 'הוסיפי עוד כישורים (שאפי ל-6+)', en: 'Add more skills (aim for 6+)' }, { he: 'יש לך 3–5 כישורים - הוספת עוד תגדיל את הנראות שלך בחיפושים', en: 'You have 3–5 skills - adding more will increase your visibility in searches' }],
  },
  photo: { full: [{ he: 'תמונת פרופיל', en: 'Profile photo' }, { he: 'פרופילים עם תמונה מקבלים 40% יותר פניות ממגייסים', en: 'Profiles with a photo get 40% more recruiter outreach' }] },
  about: {
    full: [{ he: 'קטע אודות', en: 'About section' }, { he: 'סיפור אישי מגדיל את הסיכוי לפנייה ישירה', en: 'A personal story increases the chance of direct outreach' }],
    partial: [{ he: 'הרחיבי את קטע האודות', en: 'Expand your About section' }, { he: 'הביוגרפיה שלך קצת קצרה - שאפי ל-200+ תווים כדי לעשות רושם אמיתי', en: 'Your bio is a bit short - aim for 200+ characters to make a real impression' }],
  },
  connections: {
    full: [{ he: 'קשרים בקהילה', en: 'Community connections' }, { he: 'התחברי לחברי קהילה כדי להרחיב את הרשת שלך', en: 'Connect with community members to expand your network' }],
    partial: [{ he: 'קשרים בקהילה', en: 'Community connections' }, { he: 'המשיכי להתחבר - שאפי ל-30+ קשרים לקבלת ניקוד מלא', en: 'Keep connecting - aim for 30+ connections for full credit' }],
  },
  education: { full: [{ he: 'השכלה', en: 'Education' }, { he: 'מציגה את הרקע האקדמי ואת ההסמכות שלך למגייסים', en: 'Shows your academic background and qualifications to recruiters' }] },
  certifications: { full: [{ he: 'הסמכות ותעודות', en: 'Certifications' }, { he: 'הסמכות מוסיפות אמינות ומופיעות בחיפושי מגייסים', en: 'Certifications validate your expertise and appear in recruiter searches' }] },
  location: { full: [{ he: 'מיקום', en: 'Location' }, { he: 'מגייסות מסננות לפי מיקום - הוסיפי את שלך כדי להופיע בחיפושים מקומיים', en: 'Recruiters filter by location - add yours to appear in local searches' }] },
  // headline has no copy on the site's strength card; written to match it.
  headline: { full: [{ he: 'כותרת מקצועית', en: 'Professional headline' }, { he: 'הכותרת מופיעה בתוצאות החיפוש ונותנת למגייסות רושם ראשון', en: 'Your headline appears in search results and gives recruiters a first impression' }] },
}

export interface WelcomeData {
  firstName: string
  strength: { percentage: number; tier: string; nextItem: { key: string; score: number } | null } | null
}

function featureList(): string {
  const rows = FEATURES.map((f) => `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};">${biColumns({
    he: `<div style="font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND};margin:0 0 2px;">${f.he[0]}</div>${paragraph(f.he[1])}`,
    en: `<div style="font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND};margin:0 0 2px;">${f.en[0]}</div>${paragraph(f.en[1])}`,
  }, { tight: true })}</td></tr>`).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 6px;">${rows}</table>`
}

function strengthBox(s: NonNullable<WelcomeData['strength']>): string {
  const pct = Math.max(0, Math.min(100, s.percentage))
  const tier = TIER[s.tier] ?? { he: s.tier, en: s.tier }
  const tip = s.nextItem ? TIPS[s.nextItem.key] : undefined
  const [label, text] = tip ? (s.nextItem!.score > 0 && tip.partial ? tip.partial : tip.full) : [null, null]
  const unlock = pct < INVITE_UNLOCK_PCT
    ? biColumns({
      he: paragraph(`ב-${INVITE_UNLOCK_PCT}% ייפתחו לך הזמנות אישיות לעמיתות.`),
      en: paragraph(`At ${INVITE_UNLOCK_PCT}%, you'll unlock personal invitations for colleagues.`),
    }, { tight: true })
    : ''
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;background:#faf5fb;border:1px solid ${LINE};border-radius:10px;">
    <tr><td style="padding:14px 16px 6px;">${biColumns({
      he: `<b style="font-family:${FONT};font-size:14px;color:#1d1d1f;">חוזק פרופיל: ${pct}% · ${tier.he}</b>`,
      en: `<b style="font-family:${FONT};font-size:14px;color:#1d1d1f;">Profile strength: ${pct}% · ${tier.en}</b>`,
    }, { tight: true })}</td></tr>
    <tr><td style="padding:4px 16px 10px;" dir="rtl">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LINE};border-radius:999px;"><tr>
        <td width="${pct}%" style="height:8px;line-height:8px;font-size:0;background:${BRAND};border-radius:999px;">&nbsp;</td>
        <td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td>
      </tr></table>
    </td></tr>
    ${label && text ? `<tr><td style="padding:2px 16px 8px;">${biColumns({
      he: paragraph(`<b>${label.he}</b> · ${text.he}`),
      en: paragraph(`<b>${label.en}</b> · ${text.en}`),
    }, { tight: true })}</td></tr>` : ''}
    ${unlock ? `<tr><td style="padding:0 16px 8px;">${unlock}</td></tr>` : ''}
  </table>`
}

export function renderWelcome(d: WelcomeData, unsubscribeUrl: string | null): string {
  // dir="auto": a Hebrew name inside the English line (and vice versa) keeps its own direction
  const name = d.firstName.trim() ? `<span dir="auto">${esc(d.firstName.trim())}</span>` : ''
  const body =
    biColumns({
      he: heading(name ? `ברוכה הבאה, ${name}! 👋` : 'ברוכה הבאה! 👋') + paragraph('כמה רגעים להתחיל - ועולם שלם של קשרים.'),
      en: heading(name ? `Welcome, ${name}! 👋` : 'Welcome! 👋') + paragraph('A few moments to set up - a lifetime of connections.'),
    }) +
    featureList() +
    button({ he: 'בואי נתחיל', en: "Let's Get Started" }, `${APP_URL()}/`) +
    (d.strength ? strengthBox(d.strength) : '')
  return renderLayout({
    preheader: { he: 'המקום שבו נשות הייטק חרדיות משתפות תובנות אמיתיות וצומחות יחד.', en: 'Where Orthodox women in tech share real insights and grow - all in.' },
    body,
    reason: { he: 'קיבלת את המייל הזה כי הצטרפת לדואולין.', en: "You received this email because you joined duallin." },
    unsubscribeUrl,
  })
}

/** Sends the welcome email to one member (at most once — dedupe on kind + ref_key). */
export async function sendWelcomeEmail(userId: string, opts: { immediate?: boolean } = {}): Promise<SendResult | null> {
  const db = adminClient()
  const { data: user } = await db.from('users').select('uuid, email, first_name, status').eq('uuid', userId).maybeSingle()
  if (!user?.email || user.status !== 'Active') return null
  const strength = await calculateProfileStrength(db, userId).catch(() => null)
  const name = (user.first_name ?? '').trim()
  return sendEmail({
    kind: 'welcome',
    category: 'onboarding',
    to: user.email,
    userId,
    refKey: 'welcome',
    subject: name ? `ברוכה הבאה לדואולין, ${name} | Welcome to duallin, ${name}` : 'ברוכה הבאה לדואולין | Welcome to duallin',
    html: ({ unsubscribeUrl }) => renderWelcome({ firstName: name, strength }, unsubscribeUrl),
    immediate: opts.immediate,
  })
}

/** Hourly retry: members activated in the last few days whose welcome didn't go out (e.g. a send failure). */
export async function welcomeJob(): Promise<number> {
  const db = adminClient()
  const since = new Date(Date.now() - CATCH_UP_DAYS * 86400000).toISOString()
  const { data: users } = await db.from('users').select('uuid').eq('status', 'Active').gte('activated_at', since).limit(500)
  if (!users?.length) return 0
  const ids = users.map((u) => u.uuid)
  const { data: done } = await db.from('email_log').select('user_id')
    .eq('kind', 'welcome').in('user_id', ids).in('status', ['sent', 'delivered', 'bounced', 'complained', 'skipped'])
  const skip = new Set((done ?? []).map((r) => r.user_id))
  let sent = 0
  for (const id of ids) {
    if (skip.has(id)) continue
    const r = await sendWelcomeEmail(id)
    if (r?.status === 'sent') sent++
  }
  return sent
}
