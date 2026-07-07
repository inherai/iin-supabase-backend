// _scoreHelpers.ts
// Shared scoring logic for activity score and profile strength.
// Used by me.ts (display) and invite.ts (gate + dynamic limit).

// ── Signal score helpers (pure) ───────────────────────────────────────────────

function signalPostScore(eff: number): number {
  if (eff === 0)  return 0
  if (eff < 2)    return 2   // 1
  if (eff < 4)    return 4   // 2–3
  if (eff < 7)    return 6   // 4–6
  if (eff < 11)   return 8   // 7–10
  return 10                   // 11+
}

function signalCommentScore(eff: number): number {
  if (eff === 0)  return 0
  if (eff < 3)    return 2   // 1–2
  if (eff < 8)    return 4   // 3–7
  if (eff < 16)   return 6   // 8–15
  if (eff < 26)   return 8   // 16–25
  return 10                   // 26+
}

function signalReactionScore(eff: number): number {
  if (eff === 0)  return 0
  if (eff < 6)    return 2   // 1–5
  if (eff < 16)   return 4   // 6–15
  if (eff < 31)   return 6   // 16–30
  if (eff < 51)   return 8   // 31–50
  return 10                   // 51+
}

function signalConnectionScore(eff: number): number {
  if (eff === 0)  return 0
  if (eff < 2)    return 3.5 // 1
  if (eff < 4)    return 5.5 // 2–3
  if (eff < 7)    return 7.5 // 4–6
  return 10                   // 7+
}

function signalActiveDaysScore(activeDays: number, actualDays: number): number {
  const periodDays = Math.min(actualDays, 30)
  if (periodDays === 0) return 0
  const normalized = (activeDays / periodDays) * 30
  if (normalized === 0) return 0
  if (normalized < 3)   return 2  // 1–2
  if (normalized < 6)   return 4  // 3–5
  if (normalized < 11)  return 6  // 6–10
  if (normalized < 19)  return 8  // 11–18
  return 10                        // 19+
}

// ── Pure composite calculation ────────────────────────────────────────────────

interface ActivitySignals {
  postsEff: number
  commentsEff: number
  reactionsEff: number
  connectionsEff: number
  activeDays: number
  actualDays: number
}

export function computeActivityScore(signals: ActivitySignals): {
  score: number
  P: number; C: number; R: number; N: number; A: number
} {
  const P = signalPostScore(signals.postsEff)
  const C = signalCommentScore(signals.commentsEff)
  const R = signalReactionScore(signals.reactionsEff)
  const N = signalConnectionScore(signals.connectionsEff)
  const A = signalActiveDaysScore(signals.activeDays, signals.actualDays)

  const E = Math.min(10, C * 0.70 + R * 0.30 + Math.min(C, R) * 0.20)

  const primary = Math.max(P, E)
  const secondary = Math.min(P, E)
  const contentScore = Math.min(10, primary * 0.70 + secondary * 0.50)

  const activeDomains = (P > 0 ? 1 : 0) + (E > 0 ? 1 : 0) + (N > 0 ? 1 : 0)
  const diversityMult = 1 + (activeDomains - 1) * 0.02

  const base = contentScore * 0.55 + N * 0.25 + A * 0.20
  const score = Math.min(100, Math.round(base * 10 * diversityMult))

  return { score, P, C, R, N, A }
}

// ── Tier helpers (pure) ───────────────────────────────────────────────────────

export function activityTier(score: number): { tier: string; tierLabel: string } {
  if (score >= 86) return { tier: 'elite',       tierLabel: 'עילית' }
  if (score >= 71) return { tier: 'influential', tierLabel: 'משפיעה' }
  if (score >= 51) return { tier: 'active',      tierLabel: 'פעילה' }
  if (score >= 31) return { tier: 'participant', tierLabel: 'משתתפת' }
  if (score >= 16) return { tier: 'observer',    tierLabel: 'מתעניינת' }
  return              { tier: 'dormant',      tierLabel: 'שקטה' }
}

export function profileStrengthTier(percentage: number): { tier: string; tierLabel: string } {
  if (percentage >= 95) return { tier: 'Elite',    tierLabel: 'עילית' }
  if (percentage >= 85) return { tier: 'Expert',   tierLabel: 'מקצועית' }
  if (percentage >= 70) return { tier: 'Strong',   tierLabel: 'מבוססת' }
  if (percentage >= 40) return { tier: 'Building', tierLabel: 'בונה' }
  return                   { tier: 'Starter',   tierLabel: 'מתחילה' }
}

// ── Weekly invite limit (pure) ────────────────────────────────────────────────

export function getWeeklyLimit(activityScore: number, profilePct: number): number {
  let base = activityScore >= 86 ? 10
           : activityScore >= 71 ? 7
           : activityScore >= 51 ? 4
           : 2  // participant 31–50

  if (profilePct >= 95) base += 2
  else if (profilePct >= 85) base += 1

  return base
}

// ── Profile strength (async DB) ───────────────────────────────────────────────

export async function calculateProfileStrength(supabase: any, userId: string) {
  const [userRes, connRes] = await Promise.all([
    supabase
      .from('users')
      .select('headline, about, skills, experience, education, certifications, projects, location, image')
      .eq('uuid', userId)
      .single(),
    supabase
      .from('connections')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'accepted')
      .or(`requester_id.eq.${userId},receiver_id.eq.${userId}`),
  ])

  if (userRes.error) throw new Error(userRes.error.message)

  const userData = userRes.data
  const connections = connRes.count ?? 0

  const hasPhoto = !!(userData.image && userData.image !== 'null' && userData.image !== 'false')

  const aboutText = userData.about?.trim() ?? ''
  const aboutScore = aboutText.length === 0 ? 0 : aboutText.length < 200 ? 0.5 : 1

  const experienceList: any[] = userData.experience ?? []
  const hasExpWithDesc = experienceList.some(
    (e) => (e?.description ?? e?.summary ?? '').trim().length >= 30
  )
  const experienceScore = experienceList.length === 0 ? 0 : hasExpWithDesc ? 1 : 0.5

  const skillsCount = userData.skills?.length ?? 0
  const skillsScore = skillsCount >= 6 ? 1 : skillsCount >= 3 ? 0.5 : 0

  const projectsList: any[] = userData.projects ?? []
  const hasRichProject = projectsList.some(
    (p) => (p?.description ?? '').trim().length >= 30 || p?.url
  )
  const projectsScore = projectsList.length === 0 ? 0 : hasRichProject ? 1 : 0.5

  // Experience and projects are equivalent alternatives: the better one sets the
  // score, and a partial second one can top it up — but neither is required as
  // long as the other is complete. Both missing costs exactly what experience
  // alone used to cost (0.22), never more.
  const expProjScore = Math.min(1, Math.max(experienceScore, projectsScore) + 0.5 * Math.min(experienceScore, projectsScore))

  const connectionsScore =
    connections >= 30 ? 1    :
    connections >= 15 ? 0.75 :
    connections >= 5  ? 0.5  :
    connections >= 1  ? 0.25 : 0

  const items = [
    {
      key: 'experience',
      label: expProjScore > 0 && expProjScore < 1 ? 'Complete your experience or projects' : 'Experience or projects',
      tip: expProjScore === 0
        ? 'The single most important section — add work experience or a project to show what you can do'
        : 'Great start! Add role descriptions, or a project with a description or link, to reach full score',
      score: expProjScore,
      weight: 0.22,
    },
    {
      key: 'skills',
      label: skillsScore === 0.5 ? 'Add more skills (aim for 6+)' : 'Skills',
      tip: skillsScore === 0
        ? 'Recruiters search by skills — this is one of the first filters they use'
        : 'You have some skills listed — aim for 6+ to maximize visibility in recruiter searches',
      score: skillsScore,
      weight: 0.20,
    },
    {
      key: 'photo',
      label: 'Profile photo',
      tip: 'Profiles with a photo get significantly more recruiter attention and connection requests',
      score: hasPhoto ? 1 : 0,
      weight: 0.12,
    },
    {
      key: 'about',
      label: aboutScore === 0.5 ? 'Expand your About section' : 'About section',
      tip: aboutScore === 0.5
        ? 'Your bio is a bit short — aim for 200+ characters to make a real impression on recruiters'
        : 'A well-written bio helps recruiters understand who you are beyond your job titles',
      score: aboutScore,
      weight: 0.11,
    },
    {
      key: 'headline',
      label: 'Professional headline',
      tip: 'Your headline appears in search results and gives recruiters an instant sense of who you are',
      score: userData.headline?.trim() ? 1 : 0,
      weight: 0.10,
    },
    {
      key: 'connections',
      label: 'Community connections',
      tip: connectionsScore === 0
        ? 'Start connecting — an active network makes your profile more credible to recruiters'
        : 'Keep connecting — aim for 30+ connections to reach full score',
      score: connectionsScore,
      weight: 0.09,
      activity: true,
    },
    {
      key: 'education',
      label: 'Education',
      tip: 'Adding your academic background helps recruiters assess your qualifications',
      score: (userData.education?.length ?? 0) >= 1 ? 1 : 0,
      weight: 0.08,
    },
    {
      key: 'certifications',
      label: 'Certifications',
      tip: 'Certifications validate specific expertise and can set you apart in recruiter searches',
      score: (userData.certifications?.length ?? 0) >= 1 ? 1 : 0,
      weight: 0.05,
    },
    {
      key: 'location',
      label: 'Location',
      tip: 'Some recruiters filter by location — add yours to appear in local job searches',
      score: userData.location?.trim() ? 1 : 0,
      weight: 0.03,
    },
  ]

  const totalScore = items.reduce((sum, i) => sum + i.score * i.weight, 0)
  const percentage = Math.round(totalScore * 100)
  const nextItem = items.filter((i) => i.score < 1).sort((a, b) => b.weight - a.weight)[0] ?? null
  const { tier, tierLabel } = profileStrengthTier(percentage)

  return { items, percentage, tier, tierLabel, nextItem }
}

// ── Activity score (async DB) ─────────────────────────────────────────────────

export async function calculateActivityScore(
  supabase: any,
  userId: string,
  userEmail: string,
  actualDays: number,
) {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const sevenDaysAgo  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()
  const effectiveDays = Math.max(10, Math.min(actualDays, 30))

  const [
    postsRecent, postsOlder,
    commentsRecent, commentsOlder,
    reactionsRecent, reactionsOlder,
    connsRecent, connsOlder,
    activeDaysRes,
  ] = await Promise.all([
    supabase.from('posts').select('id', { count: 'exact', head: true })
      .eq('sender', userEmail).not('post_type', 'is', null).neq('post_type', 'email')
      .gte('sent_at', sevenDaysAgo),
    supabase.from('posts').select('id', { count: 'exact', head: true })
      .eq('sender', userEmail).not('post_type', 'is', null).neq('post_type', 'email')
      .lt('sent_at', sevenDaysAgo).gte('sent_at', thirtyDaysAgo),

    supabase.from('comments').select('id, posts!inner(post_type)', { count: 'exact', head: true })
      .eq('sender', userEmail).not('posts.post_type', 'is', null).neq('posts.post_type', 'email')
      .gte('created_at', sevenDaysAgo),
    supabase.from('comments').select('id, posts!inner(post_type)', { count: 'exact', head: true })
      .eq('sender', userEmail).not('posts.post_type', 'is', null).neq('posts.post_type', 'email')
      .lt('created_at', sevenDaysAgo).gte('created_at', thirtyDaysAgo),

    supabase.from('likes').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).gte('created_at', sevenDaysAgo),
    supabase.from('likes').select('id', { count: 'exact', head: true })
      .eq('user_id', userId).lt('created_at', sevenDaysAgo).gte('created_at', thirtyDaysAgo),

    supabase.from('connections').select('id', { count: 'exact', head: true })
      .eq('status', 'accepted').or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .gte('created_at', sevenDaysAgo),
    supabase.from('connections').select('id', { count: 'exact', head: true })
      .eq('status', 'accepted').or(`requester_id.eq.${userId},receiver_id.eq.${userId}`)
      .lt('created_at', sevenDaysAgo).gte('created_at', thirtyDaysAgo),

    supabase.rpc('count_active_days', {
      p_user_id: userId,
      p_user_email: userEmail,
      p_since: thirtyDaysAgo,
    }),
  ])

  const postsEff       = (postsRecent.count    ?? 0) * 2 + (postsOlder.count    ?? 0)
  const commentsEff    = (commentsRecent.count  ?? 0) * 2 + (commentsOlder.count  ?? 0)
  const reactionsEff   = (reactionsRecent.count ?? 0) * 2 + (reactionsOlder.count ?? 0)
  const connectionsEff = (connsRecent.count     ?? 0) * 2 + (connsOlder.count     ?? 0)
  const activeDays     = activeDaysRes.data ?? 0

  const signals: ActivitySignals = { postsEff, commentsEff, reactionsEff, connectionsEff, activeDays, actualDays }
  const { score, P, C, R, N, A } = computeActivityScore(signals)
  const { tier, tierLabel } = activityTier(score)

  // nextAction: simulate one "effort unit" for each action type
  const nextTierScore =
    score >= 86 ? null :
    score >= 71 ? 86 :
    score >= 51 ? 71 :
    score >= 31 ? 51 :
    score >= 16 ? 31 : 16

  const candidates = [
    {
      type: 'post' as const,
      label: 'Write a post',
      tip: 'Share your expertise with the community',
      newSignals: { ...signals, postsEff: postsEff + 2 },
    },
    {
      type: 'comment' as const,
      label: 'Comment on 2 posts',
      tip: 'Engage with what others are sharing',
      newSignals: { ...signals, commentsEff: commentsEff + 4 },
    },
    {
      type: 'reaction' as const,
      label: 'React to 5 posts',
      tip: 'Show support for posts that resonate with you',
      newSignals: { ...signals, reactionsEff: reactionsEff + 10 },
    },
    {
      type: 'connect' as const,
      label: 'Connect with someone new',
      tip: 'Grow your professional network',
      newSignals: { ...signals, connectionsEff: connectionsEff + 2 },
    },
  ].map((c) => ({ ...c, newScore: computeActivityScore(c.newSignals).score }))
   .sort((a, b) => b.newScore - a.newScore)

  const best = candidates[0]
  const nextAction = best && best.newScore > score
    ? {
        type:       best.type,
        label:      best.label,
        tip:        best.tip,
        impact:     best.newScore - score,
        toNextTier: nextTierScore !== null ? Math.max(0, nextTierScore - best.newScore) : 0,
      }
    : null

  return {
    score,
    tier,
    tierLabel,
    signals: { posts: postsEff, comments: commentsEff, reactions: reactionsEff, connections: connectionsEff, activeDays },
    nextAction,
    canInvite: score >= 31,
    effectiveDays,
    actualDays,
  }
}
