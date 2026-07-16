// supabase/functions/api/routes/posts.ts
import { Hono } from 'https://deno.land/x/hono/mod.ts'
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "https://esm.sh/openai@4";

const app = new Hono()

const VALID_POST_TYPES = new Set(['discussion', 'question', 'job', 'article', 'milestone', 'share', 'email', 'linkedin']);

// ====================================================================
// 1. הגדרות ופונקציות עזר (Logic Helpers)
// ====================================================================

function plainTextLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .length;
}

function isQualityPost(message: string): boolean {
  if (!message) return false;
  const cleanMsg = message.toLowerCase().trim();
  const noiseWords = ["מקפיצה", "up", "הקפצה", "מעלה", "תודה"];
  const isNoise = noiseWords.some(word => cleanMsg.includes(word));
  const isTooShort = cleanMsg.length < 10;
  return !isNoise && !isTooShort;
}

async function deterministicInt8(seed: string): Promise<number> {
  const data = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) + BigInt(bytes[i]);
  return Number(n & 0x1fffffffffffffn);
}

// PostgREST caps every response at 1000 rows and supabase-js reports no error for the
// truncation, so bulk .in() lookups (likes/comments for a feed batch) silently lose rows
// once the batch is large enough — posts then render with 0 likes. Fetch in ID chunks and
// page each chunk to completion; ordered by id so range pagination is stable.
async function fetchAllByIds(
  supabase: any,
  table: string,
  select: string,
  idColumn: string,
  ids: string[],
  applyFilters?: (q: any) => any,
): Promise<any[]> {
  const CHUNK_SIZE = 100
  const PAGE_SIZE = 1000
  const rows: any[] = []
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE)
    for (let from = 0; ; from += PAGE_SIZE) {
      let query = supabase
        .from(table)
        .select(select)
        .in(idColumn, chunk)
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (applyFilters) query = applyFilters(query)
      const { data, error } = await query
      if (error) {
        console.error(`[feed] fetch ${table} by ${idColumn} failed:`, error.message)
        break
      }
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }
  }
  return rows
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function updatePostVector(postId: any) {
  try {
    const openai = new OpenAI({ apiKey: Deno.env.get("TEST_OPENAI_API_KEY") });
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: post, error } = await supabaseAdmin
      .from("posts")
      .select(`subject, message, comments (message)`)
      .eq("id", postId)
      .single();

    if (error || !post) return;

    const subject = post.subject || "";
    const message = stripHtml(post.message || "");
    const commentsText = (post.comments ?? [])
      .map((c: any) => stripHtml(c.message || ""))
      .join("\n");

    const fullText = `Subject: ${subject}\nMessage: ${message}\nComments:\n${commentsText}`.trim();

    const embRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: fullText.slice(0, 8000),
    });

    await supabaseAdmin.from("vectors").upsert({
      postid: postId,
      vector: embRes.data[0].embedding,
    }, { onConflict: 'postid' });

    console.log(` Vector updated for post: ${postId}`);
  } catch (err) {
    console.error(" Error updating vector:", err);
  }
}

const RECRUITER_ROLE = 'recruiters';

function isRecruiterViewer(user: any): boolean {
  const role = String(user?.app_metadata?.role ?? '').toLowerCase().trim();
  return role === RECRUITER_ROLE;
}
//support all types of attachment.

const PPTX_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/powerpoint',
  'application/x-mspowerpoint',
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp', 'png', 'gif', 'bmp', 'dib',
  'webp', 'avif', 'heic', 'heif', 'svg', 'svgz', 'ico', 'tif', 'tiff',
  'apng',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'qt', 'avi', 'wmv', 'flv', 'f4v', 'mkv', 'webm',
  'mpeg', 'mpg', 'mpe', 'mpv', '3gp', '3gpp', '3g2', 'mts', 'm2ts', 'ts',
  'ogv', 'vob',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'wave', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma',
  'aiff', 'aif', 'aifc', 'amr', 'mid', 'midi',
]);

function firstString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

// Category words like 'document'/'image' are not MIME types — a real MIME always has a '/'
function firstMimeType(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.includes('/') && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractExtension(value: string | null): string | null {
  if (!value) return null;
  const cleanValue = value.split('?')[0].split('#')[0];
  const fileName = cleanValue.split('/').pop() ?? cleanValue;
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === fileName.length - 1) return null;
  return fileName.slice(dotIdx + 1).toLowerCase();
}

function deriveFileName(url: string | null): string | null {
  if (!url) return null;
  const cleanValue = url.split('?')[0].split('#')[0];
  const fileName = cleanValue.split('/').pop() ?? cleanValue;
  return fileName || null;
}

function inferAttachmentType(mimeType: string | null, extension: string | null): 'image' | 'video' | 'audio' | 'slides' | 'file' {
  const normalizedMime = mimeType?.toLowerCase().trim() ?? '';
  const normalizedExt = extension?.toLowerCase().trim() ?? '';

  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';

  if (PPTX_MIME_TYPES.has(normalizedMime) || normalizedExt === 'pptx') return 'slides';
  if (normalizedExt && IMAGE_EXTENSIONS.has(normalizedExt)) return 'image';
  if (normalizedExt && VIDEO_EXTENSIONS.has(normalizedExt)) return 'video';
  if (normalizedExt && AUDIO_EXTENSIONS.has(normalizedExt)) return 'audio';
  return 'file';
}

function toOfficeSlidesViewerUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return null;
    return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
  } catch {
    return null;
  }
}

function normalizeAttachment(rawAttachment: any) {
  if (rawAttachment === null || rawAttachment === undefined) return null;

  const base =
    typeof rawAttachment === 'object' && !Array.isArray(rawAttachment)
      ? rawAttachment
      : { url: String(rawAttachment) };

  const url = firstString(
    base.url,
    base.uri,
    base.path,
    base.src,
    base.file_url,
    base.publicUrl,
    base.public_url,
    base.localPath,
    base.local_path,
  );

  const name = firstString(
    base.name,
    base.fileName,
    base.filename,
    base.originalName,
    base.original_name,
  ) ?? deriveFileName(url);

  const incomingMimeType = firstMimeType(
    base.mime_type,
    base.mimeType,
    base.contentType,
    base.content_type,
    base.type,
  );

  const extension = extractExtension(name) ?? extractExtension(url);
  const attachmentType = inferAttachmentType(incomingMimeType, extension);

  const display =
    attachmentType === 'slides'
      ? {
        as: 'slides',
        viewer: 'office',
        embed_url: toOfficeSlidesViewerUrl(url),
        has_thumbnail: false,
      }
      : attachmentType === 'image'
      ? {
        as: 'image',
        viewer: 'native',
        has_thumbnail: true,
      }
      : attachmentType === 'video'
      ? {
        as: 'video',
        viewer: 'native',
        has_thumbnail: true,
      }
      : attachmentType === 'audio'
      ? {
        as: 'audio',
        viewer: 'native',
        has_thumbnail: false,
      }
      : {
        as: 'file',
        viewer: 'download',
        has_thumbnail: false,
      };

  return {
    ...base,
    url: url ?? null,
    name: name ?? null,
    mime_type: incomingMimeType?.toLowerCase() ?? null,
    file_extension: extension ?? null,
    attachment_type: attachmentType,
    display,
  };
}

function normalizeAttachments(rawAttachments: any): any[] {
  if (rawAttachments === null || rawAttachments === undefined) return [];
  const attachmentsList = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
  return attachmentsList
    .map((attachment) => normalizeAttachment(attachment))
    .filter((attachment) => attachment !== null);
}

function toStoragePath(v: any): string | null {
  if (!v) return null;

  const s = (typeof v === 'string' ? v : (v.localPath || v.url || '')).toString().trim();
  if (!s) return null;

  // אם זה כבר path יחסי
  if (!s.startsWith('http')) return s;

  // אם זה URL מלא - נחלץ את החלק שאחרי /attachments/
  const parts = s.split('/attachments/');
  if (parts.length > 1) return parts[1].trim();

  return null;
}
//support all types of attachment.

function extractMentionedUserIds(message: string): string[] {
  const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  // Plain text format: @[Name](uuid)
  const plainMatches = [...message.matchAll(new RegExp(`@\\[[^\\]]+\\]\\((${uuidPattern})\\)`, 'gi'))].map(m => m[1]);
  // HTML format: data-user-id="uuid"
  const htmlMatches = [...message.matchAll(new RegExp(`data-user-id="(${uuidPattern})"`, 'gi'))].map(m => m[1]);
  return [...new Set([...plainMatches, ...htmlMatches])];
}

async function insertMentionNotifications(
  supabase: any,
  message: string,
  actorId: string,
  targetId: string,
  excludeIds: string[] = [],
) {
  const mentionedIds = extractMentionedUserIds(message);
  if (mentionedIds.length === 0) return;

  for (const mentionedId of mentionedIds) {
    if (mentionedId === actorId) continue;
    if (excludeIds.includes(mentionedId)) continue;
    const { error } = await supabase.from('notifications').insert({
      user_id: mentionedId,
      actor_id: actorId,
      target_id: targetId,
      type: 'MENTION',
      count: 1,
      is_read: false,
    });
    if (error) console.error('[mention] failed to insert notification:', error.message, { mentionedId, actorId, targetId });
  }
}

function buildCompanyAuthor(company: { name: string; logo?: string | null }) {
  return {
    first_name: company.name,
    last_name: null,
    image: company.logo ?? null,
    is_anonymous: false,
  }
}

async function insertReplyNotification(supabase: any, actorId: string, parentCommentAuthorId: string, postId: string) {
  if (actorId === parentCommentAuthorId) return;
  const { error } = await supabase.from('notifications').insert({
    user_id: parentCommentAuthorId,
    actor_id: actorId,
    target_id: postId,
    type: 'REPLY',
    count: 1,
    is_read: false,
  });
  if (error) console.error('[reply] failed to insert notification:', error.message, { parentCommentAuthorId, actorId, postId });
}

// ====================================================================
// Feed Ranking v2 — completely separate handler, existing flow untouched
// Activated when ?feed_ranking=v2 is present, or in ?ids= mode (explicit
// post list, e.g. AI search results — enriched without ranking/pagination)
// ====================================================================

// ── Scoring config — single source of truth for all tunable parameters ──
const FEED_SCORE = {
  commentWeight: 2,
  likeWeight: 1,
  networkCommentBoost: 5,
  networkLikeBoost: 1,
  connectionPostBoost: 10,
  tier1WindowMs: 30 * 60 * 1000,
  // exposure boost: פוסט שטרם צבר מספיק חשיפות מקבל boost יורד בהדרגה
  lowExposureWindowHours: 24,  // חלון 24ש — פוסט לילי מקבל הגנה עד שהקהל מתעורר
  lowExposureThreshold: 80,    // median ב-3 שעות = 57, P75 = 76 → 80 = "חשיפה הוגנת"
  lowExposureBoost: 1.8,       // מקסימום boost (ב-0 impressions)
  highEngagementThreshold: 15,    // כמות engagement כוללת (תגובות×2 + לייקים×1) לתג "פעיל בקהילה"
  likeGravityFactor: 4,        // לייק נחשב ישן פי 4 מתגובה לצורך חישוב gravity
  unseenBoost: 1.3,            // פוסט שמעולם לא הוצג למשתמש הזה מקבל יתרון על פוסט שנראה
  freshnessStrength: 1.5,      // עוצמת ה-boost בזמן 0 → score × (1 + freshnessStrength) = ×2.5
  freshnessWindowHours: 1,     // אחרי כמה שעות ה-freshness נעלם לחלוטין
  // gravity split — total = 1.2 in both cases
  // seen post:   activityAge dominates, light post-age penalty
  seenActivityAgePower: 1.0,
  seenPostAgePower: 0.2,
  // unseen post: postAge dominates, activity recency still matters
  unseenPostAgePower: 0.8,
  unseenActivityAgePower: 0.4,
}

// derived constant — HOURS_TIER1 never changes at runtime
const HOURS_TIER1 = FEED_SCORE.tier1WindowMs / 3_600_000

// ── ScoreContext — all per-request data scorePost needs ──
interface ScoreContext {
  lastSeenMap: Record<string, string | null>
  cappedLastLoginAt: string | null
  session_start: string
  impressionCountMap: Map<string, number>
  connectedUuids: Set<string>
  usersByEmail: Map<string, any>
  usersByUuid: Map<string, any>
  recentActivityCutoff: string
}

// ── scorePost — pure scoring + v2 context-line fields for one post ──
//
// ALGORITHM OVERVIEW
// ==================
// Goal: rank posts by personal relevance, not just recency.
// Each post gets a numeric score derived from:
//   rawScore   = engagement_numerator / gravity_denominator
//   finalScore = rawScore × freshnessBoost × exposureBoost × unseenBoost
//
// The result is a float. Posts are sorted descending, with a tier1 bucket
// (very recent/hot) always appearing above the rest regardless of score.
//
function scorePost(
  post: any,
  postLikes: any[],
  postComments: any[],
  ctx: ScoreContext,
): { score: number; tier1: boolean; v2: Record<string, any> } {
  const {
    lastSeenMap, cappedLastLoginAt, session_start,
    impressionCountMap, connectedUuids, usersByEmail, usersByUuid,
    recentActivityCutoff,
  } = ctx

  // ── STEP 1: Temporal anchoring ───────────────────────────────────────
  //
  // Two separate reference points with different purposes:
  //
  // scoringRef — for engagement numerator + gravity denominator (SCORING only).
  //   Always cappedLastLoginAt (user's last feed visit), same checkpoint for ALL
  //   posts. Prevents the "stale impression" paradox: a post seen 3 days ago won't
  //   accumulate a 3-day window of "new" engagement above posts from yesterday.
  //   null on cold start → full engagement history counts (new-user seeding).
  //
  // uiBaseline — for context-line UI (new comment counts, network commenters).
  //   Uses lastSeenAt (actual impression for THIS post) when available. The user
  //   genuinely hasn't seen comments that arrived after they last viewed this
  //   specific post — even if they've visited the feed since without seeing it.
  //   Falls back: lastSeenAt → cappedLastLoginAt → session_start.
  //
  // lastSeenAt alone drives novelty signals (unseenBoost, isNeverSeen, isNewPost)
  // — whether this specific post has ever been shown to this user.
  //
  const lastSeenAt: string | null = lastSeenMap[String(post.id)] ?? null
  const scoringRef: string | null = cappedLastLoginAt
  const uiContextRef: string | null = lastSeenAt ?? cappedLastLoginAt
  const uiBaseline: string = uiContextRef ?? session_start
  const sentAt: string = post.sent_at ?? post.effective_sort_date ?? new Date().toISOString()
  const hoursSincePosted = Math.max(0, (Date.now() - new Date(sentAt).getTime()) / 3_600_000)

  // ── STEP 2: Effective engagement lists (scoring window) ─────────────
  //
  // Only engagement since scoringRef (last feed visit) counts toward the score.
  // Cold start (scoringRef = null): count full history to seed the new-user feed.
  //
  const effectiveCommentList: any[] = scoringRef
    ? postComments.filter((cm: any) => cm.created_at > scoringRef)
    : [...postComments]
  const effectiveLikeList: any[] = scoringRef
    ? postLikes.filter((l: any) => l.created_at && l.created_at > scoringRef)
    : postLikes.filter((l: any) => l.created_at)

  // ── STEP 3: Network activity (scoring window) ────────────────────────
  //
  // Activity from connected users counted since scoringRef — same window as the
  // engagement numerator. Note: older rows may lack posted_by_uuid; fall back
  // to email → uuid resolution.
  //
  const scoringWindow = scoringRef ?? session_start
  const networkCommentCount = postComments.filter((cm: any) => {
    const uuid = cm.posted_by_uuid || usersByEmail.get((cm.sender || '').toLowerCase())?.uuid
    return uuid && connectedUuids.has(uuid) && cm.created_at > scoringWindow
  }).length
  const networkLikeCount = postLikes.filter(
    (l: any) => l.user_id && connectedUuids.has(l.user_id) && l.created_at && l.created_at > scoringWindow
  ).length

  // ── STEP 4: Gravity anchor — hoursForGravity ────────────────────────
  //
  // Standard HN-style gravity uses post age as the denominator. We improve on
  // this: an OLD post with a RECENT comment should score by comment freshness,
  // not by how old the post is. So we use the most recent effective activity
  // time as the gravity anchor.
  //
  // Like gravity factor (likeGravityFactor = 4):
  //   A like from 2h ago is treated as "8 effective hours old" for gravity.
  //   Rationale: likes are passive signals; comments signal active engagement
  //   and should stay "fresh" much longer in the denominator.
  //
  // hoursForGravity = min(hoursFromComment, hoursFromLike×4, postAge)
  // Falls back to postAge when there is no effective engagement at all.
  //
  const commentTimes = effectiveCommentList
    .map((cm: any) => new Date(cm.created_at).getTime()).filter((t: number) => !isNaN(t))
  const rawLikeTimes = effectiveLikeList
    .map((l: any) => new Date(l.created_at).getTime()).filter((t: number) => !isNaN(t))
  const hoursFromComment = commentTimes.length > 0
    ? Math.max(0, (Date.now() - Math.max(...commentTimes)) / 3_600_000) : null
  const hoursFromLike = rawLikeTimes.length > 0
    ? Math.max(0, (Date.now() - Math.max(...rawLikeTimes)) / 3_600_000) * FEED_SCORE.likeGravityFactor : null
  const gravityCandidates = [hoursFromComment, hoursFromLike].filter((h): h is number => h !== null)
  const hoursForGravity = gravityCandidates.length > 0 ? Math.min(...gravityCandidates) : hoursSincePosted

  // ── STEP 5: Engagement numerator ────────────────────────────────────
  //
  // comments × 2  — comments signal deep engagement (someone wrote something)
  // likes    × 1  — lighter signal but still meaningful
  //
  // networkBoost: activity from connected users is far more relevant than
  // activity from strangers. Network comments worth 5× because they also
  // imply the content crossed into a social circle the viewer cares about.
  //
  // connectionPostBoost: if the POST AUTHOR is in the viewer's network, the
  // content itself is more relevant — not just the reaction to it.
  //
  // The leading +1 ensures posts with 0 engagement still have a positive
  // numerator (otherwise gravity would produce 0/denom = 0 for all empty posts,
  // making their sort order undefined).
  //
  const totalEngagement =
    effectiveCommentList.length * FEED_SCORE.commentWeight +
    effectiveLikeList.length   * FEED_SCORE.likeWeight
  const networkBoost =
    networkCommentCount * FEED_SCORE.networkCommentBoost +
    networkLikeCount    * FEED_SCORE.networkLikeBoost
  const connectionPostBoost =
    post.posted_by_uuid && connectedUuids.has(post.posted_by_uuid) ? FEED_SCORE.connectionPostBoost : 0
  const numerator = 1 + totalEngagement + networkBoost + connectionPostBoost

  // ── STEP 6: Gravity denominator — time decay ─────────────────────────
  //
  // Seen vs unseen posts age differently:
  //
  //   SEEN (effectiveLastSeen ≠ null):
  //     Activity age^1.0 × postAge^0.2
  //     Activity age dominates — what matters is HOW FRESH the new engagement is.
  //     A slight post-age penalty pushes truly old content down even if it has
  //     some engagement.
  //
  //   UNSEEN (cold start, effectiveLastSeen = null):
  //     postAge^0.8 × activityAge^0.4
  //     Post age dominates — we prefer showing newer content to users who have
  //     no reference point. Activity recency still contributes but less.
  //
  // Total gravity power = 1.2 in both cases (same overall decay pressure,
  // just split differently between the two time axes).
  //
  // The +2 offset prevents the denominator collapsing to 1^n at t=0,
  // which would make rawScore = numerator (too large for very new posts).
  //
  const hasSeen = scoringRef !== null
  const gravityDenominator = hasSeen
    ? Math.pow(hoursForGravity + 2, FEED_SCORE.seenActivityAgePower) *
      Math.pow(hoursSincePosted + 2, FEED_SCORE.seenPostAgePower)
    : Math.pow(hoursSincePosted + 2, FEED_SCORE.unseenPostAgePower) *
      Math.pow(hoursForGravity + 2,  FEED_SCORE.unseenActivityAgePower)

  const rawScore = numerator / gravityDenominator

  // ── STEP 7: Multipliers (applied independently on top of rawScore) ───
  //
  // Three orthogonal boosts — each addresses a different fairness problem:
  //
  // 7a. freshnessBoost
  //   Problem: a brand-new post with 0 engagement can't compete against an old
  //   post with accumulated likes. It needs a grace period to surface.
  //   Solution: linear decay from ×2.5 at t=0 to ×1.0 at freshnessWindowHours (1h).
  //   Formula: 1 + freshnessStrength × max(0, 1 - age/window)
  //
  const freshnessBoost = 1 + FEED_SCORE.freshnessStrength *
    Math.max(0, 1 - hoursSincePosted / FEED_SCORE.freshnessWindowHours)

  // 7b. exposureBoost
  //   Problem: a post published at 2am gets almost no impressions before the
  //   community wakes up. By morning it's already "old" and gravity buries it.
  //   Solution: if a post has fewer impressions than the healthy baseline (80),
  //   boost it proportionally — more so the fewer impressions it has.
  //   Formula: 1 + (maxBoost-1) × max(0, 1 - impressions/threshold)
  //   → ×1.8 at 0 impressions, ×1.0 at 80+ impressions (smooth gradient)
  //
  //   Active window: tier1 end (30min) → 24h, only for posts never seen by this user.
  //   If you've already seen the post, the exposure mission is complete for you.
  //   Starts at 30min to avoid a ×4.5 spike at t=0 (freshness + exposure).
  //
  const impressionsCount = impressionCountMap.get(String(post.id)) ?? 0
  const exposureBoost = (!lastSeenAt && hoursSincePosted >= HOURS_TIER1 && hoursSincePosted < FEED_SCORE.lowExposureWindowHours)
    ? 1 + (FEED_SCORE.lowExposureBoost - 1) * Math.max(0, 1 - impressionsCount / FEED_SCORE.lowExposureThreshold)
    : 1.0

  // 7c. unseenBoost
  //   Problem: in a small community, the same users may keep seeing the same
  //   posts, while other users never encounter them. A post "seen by everyone
  //   already" and a post "seen by no one yet" look identical in score.
  //   Solution: ×1.3 for posts that have NEVER been shown to this specific user
  //   (no impression record). Uses lastSeenAt, NOT effectiveLastSeen — we want
  //   to boost based on actual impressions, not a login-time proxy.
  //
  //   Why boost (not penalty)? Penalizing seen posts risks emptying the feed
  //   in a small community where most content has been seen. Boosting unseen
  //   content achieves the same rebalancing without degrading the feed floor.
  //
  const unseenBoost = !lastSeenAt ? FEED_SCORE.unseenBoost : 1.0

  // final score = engagement/gravity × freshness × exposure × unseen
  const score = isNaN(rawScore) ? 0 : rawScore * freshnessBoost * exposureBoost * unseenBoost

  // ── STEP 8: Context-line data (v2 UI fields) ─────────────────────────
  //
  // Uses uiBaseline — what the user genuinely hasn't seen on this specific post.
  //
  const recentComments = postComments.filter((cm: any) => cm.created_at > uiBaseline)

  // Network commenters: up to 2 connected users who commented recently.
  // Shown as avatar stack + "{name} commented" in the context line.
  const recentNetworkCommenters = recentComments
    .filter((cm: any) => {
      const uuid = cm.posted_by_uuid || usersByEmail.get((cm.sender || '').toLowerCase())?.uuid
      return uuid && connectedUuids.has(uuid)
    })
    .slice(0, 2)
    .map((cm: any) => {
      const cp = usersByEmail.get((cm.sender || '').toLowerCase()) ?? usersByUuid.get(cm.posted_by_uuid)
      const name = cp ? `${cp.first_name ?? ''} ${cp.last_name ?? ''}`.trim() : cm.sender_name ?? 'משתמש'
      const uuid = cm.posted_by_uuid || cp?.uuid || ''
      return { name: name || 'משתמש', uuid, has_image: !!cp?.image }
    })

  // All-time network activity — not filtered by uiBaseline.
  // Used in Layer 2 to explain ranking for posts where connection engagement
  // happened before uiBaseline (user has already seen that activity).
  const allTimeNetworkCommenters = postComments
    .filter((cm: any) => {
      const uuid = cm.posted_by_uuid || usersByEmail.get((cm.sender || '').toLowerCase())?.uuid
      return uuid && connectedUuids.has(uuid)
    })
    .slice(0, 2)
    .map((cm: any) => {
      const cp = usersByEmail.get((cm.sender || '').toLowerCase()) ?? usersByUuid.get(cm.posted_by_uuid)
      const name = cp ? `${cp.first_name ?? ''} ${cp.last_name ?? ''}`.trim() : cm.sender_name ?? 'משתמש'
      const uuid = cm.posted_by_uuid || cp?.uuid || ''
      return { name: name || 'משתמש', uuid, has_image: !!cp?.image }
    })

  const allTimeNetworkLikers = postLikes
    .filter((l: any) => l.user_id && connectedUuids.has(l.user_id))
    .map((l: any) => {
      const cp = usersByUuid.get(l.user_id)
      if (!cp) return null
      const name = `${cp.first_name ?? ''} ${cp.last_name ?? ''}`.trim()
      return name ? { name, uuid: l.user_id as string, has_image: !!cp.image } : null
    })
    .filter(Boolean) as Array<{ name: string; uuid: string; has_image: boolean }>

  // Merge commenters + likers, de-dupe by uuid, commenters first, max 2
  const seenUuidsHist = new Set(allTimeNetworkCommenters.map((c: any) => c.uuid))
  const historicalNetworkMembers = [
    ...allTimeNetworkCommenters,
    ...allTimeNetworkLikers.filter((l) => !seenUuidsHist.has(l.uuid)),
  ].slice(0, 2)

  // isNewPost: post the user has never seen AND was published after their
  // last reference point. On cold start, any post < 24h old qualifies —
  // acceptable since first-session users should see fresh content first.
  const sentAtMs = new Date(sentAt).getTime()
  const isNewPost = !lastSeenAt &&
    (Date.now() - sentAtMs) < 86_400_000 &&
    sentAtMs > new Date(uiContextRef ?? 0).getTime()

  // Reaction breakdown for context line — uses uiBaseline (what the user hasn't seen),
  // not effectiveLikeList (which uses scoringRef for scoring purposes).
  const uiLikeList = uiContextRef
    ? postLikes.filter((l: any) => l.created_at && l.created_at > uiBaseline)
    : postLikes.filter((l: any) => l.created_at)
  const recentReactionBreakdown: Record<string, number> = {}
  uiLikeList.forEach((l: any) => {
    const type = l.reaction_type || 'like'
    recentReactionBreakdown[type] = (recentReactionBreakdown[type] || 0) + 1
  })

  // connection author — post author is in viewer's network
  const isConnectionAuthor = !!(post.posted_by_uuid && connectedUuids.has(post.posted_by_uuid))
  const authorProfile = usersByEmail.get((post.sender || '').toLowerCase())
    ?? (post.posted_by_uuid ? usersByUuid.get(post.posted_by_uuid) : null)
  const connectionAuthorName: string | null = isConnectionAuthor && authorProfile
    ? (`${authorProfile.first_name ?? ''} ${authorProfile.last_name ?? ''}`).trim() || null
    : null

  // low exposure — post is recent but underseen (exposureBoost window active)
  const isLowExposure = hoursSincePosted >= HOURS_TIER1
    && hoursSincePosted < FEED_SCORE.lowExposureWindowHours
    && impressionsCount < FEED_SCORE.lowExposureThreshold

  // never seen — post was never shown to this user, but doesn't qualify as isNewPost (too old or pre-login)
  const isNeverSeen = lastSeenAt === null && !isNewPost

  // ── STEP 9: tier1 flag ───────────────────────────────────────────────
  //
  // tier1 posts always sort ABOVE non-tier1, regardless of score.
  // A post qualifies if ANY of:
  //   - Post itself is < 30min old AND user hasn't seen it yet
  //   - It's an "isNewPost" for this user (never seen, just posted after login)
  //   - ANY comment on the post is < 30min old AND user hasn't seen it yet
  //
  // The "not yet seen" gate (lastSeenAt === null) is intentional:
  // for posts the user has already seen, the score already accounts for new
  // engagement via the scoring window (scoringRef). Forcing tier1 on top of
  // that would recreate the old "every comment bumps to top" behavior.
  //
  const hasNeverSeen = lastSeenAt === null
  const tier1 = (hasNeverSeen && hoursSincePosted < HOURS_TIER1) || isNewPost ||
    (hasNeverSeen && postComments.some((cm: any) => cm.created_at > recentActivityCutoff))

  // ── Primary ranking reason ───────────────────────────────────────────
  //
  // Priority order matches scoring contribution weight:
  //   network          — connection activity (strongest signal)
  //   connection       — post author is in viewer's network
  //   new_post         — fresh & never seen (freshness + unseenBoost)
  //   never_seen       — never shown to user, not "new" (unseenBoost)
  //   low_exposure     — recent but underseen globally (exposureBoost)
  //   recent_activity  — community commented in last 12h
  //   high_engagement  — ≥15 weighted engagement (comments×2 + likes×1)
  //   none             — in feed by score but no notable signal
  //                      (frontend shows no context line)
  //
  const allTimeEngagement = postComments.length * FEED_SCORE.commentWeight + postLikes.length * FEED_SCORE.likeWeight
  const primaryRankingReason: string =
    networkBoost > 0             ? 'network'
    : isConnectionAuthor         ? 'connection'
    : isNewPost                  ? 'new_post'
    : isNeverSeen                ? 'never_seen'
    : isLowExposure              ? 'low_exposure'
    : allTimeEngagement >= FEED_SCORE.highEngagementThreshold ? 'high_engagement'
    : 'none'
  // NOTE: "recent community activity" is intentionally absent from this chain.
  // When a comment is new to the user → Layer 1 catches it via recentComments (uiBaseline).
  // When the user already saw the comment → any "Back in discussion" label would be misleading.
  // Either case is already handled; a standalone Layer 2 reason adds nothing.

  return {
    score,
    tier1,
    v2: {
      is_new_post: isNewPost,
      new_comments_count: recentComments.length,
      network_commenters: recentNetworkCommenters,
      has_last_seen_data: uiContextRef !== null,
      recent_likes_count: uiLikeList.length,
      recent_reaction_breakdown: recentReactionBreakdown,
      is_connection_author: isConnectionAuthor,
      connection_author_name: connectionAuthorName,
      is_low_exposure: isLowExposure,
      is_never_seen: isNeverSeen,
      primary_ranking_reason: primaryRankingReason,
      historical_network_members: historicalNetworkMembers,
    },
  }
}

async function handleRankedFeed(c: any) {
  const supabase = c.get('supabase')
  const currentUser = c.get('user')
  const current_user_uuid = currentUser?.id
  const viewerIsRecruiter = isRecruiterViewer(currentUser)

  const last_effective_date = c.req.query('last_effective_date')
  const last_id = c.req.query('last_id')
  const session_start = c.req.query('session_start') || new Date().toISOString()
  const targetUserId = c.req.query('userid')
  const excludeEmail = c.req.query('exclude_email') === 'true'

  // ids mode: enrich an explicit, pre-ranked post list (e.g. AI search results)
  // through the exact same pipeline as the ranked feed — same authors, privacy,
  // reactions, comments and saved state. Skips ranking/pagination, keeps input order.
  const idsParam = c.req.query('ids')
  const requestedIds: string[] | null = idsParam
    ? Array.from(new Set<string>(idsParam.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0))).slice(0, 100)
    : null

  let filterEmail: string | null = null
  if (targetUserId) {
    const { data: email, error: emailError } = await supabase
      .rpc('get_user_email_by_uuid', { p_uuid: targetUserId })
    if (emailError || !email) {
      return c.json({ data: [], meta: { next_cursor: null } })
    }
    filterEmail = email
  }

  let posts: any[] | null
  if (requestedIds) {
    if (requestedIds.length === 0) return c.json({ data: [], meta: { next_cursor: null } })
    const { data: idPosts, error: idPostsError } = await supabase
      .from('posts')
      .select('id, sender, subject, message, attachments, sent_at, post_type, community_members_only, company_id, posted_by_uuid, linked_article_id')
      .in('id', requestedIds)
    if (idPostsError) {
      console.error('[ranked-feed] posts-by-ids error:', idPostsError.message)
      return c.json({ data: [], meta: { next_cursor: null } })
    }

    const savedIdSet = new Set<string>()
    if (current_user_uuid && (idPosts || []).length > 0) {
      const { data: savedRows, error: savedError } = await supabase
        .from('saved_resources')
        .select('saved_resource_id')
        .eq('user_id', current_user_uuid)
        .eq('saved_resource_type', 'post')
        .in('saved_resource_id', (idPosts || []).map((p: any) => String(p.id)))
      if (savedError) console.error('[ranked-feed] posts-by-ids saved lookup error:', savedError.message)
      ;(savedRows || []).forEach((r: any) => savedIdSet.add(String(r.saved_resource_id)))
    }

    // preserve the caller's (ranking) order, normalize to the stabilized-feed row shape
    const byId = new Map((idPosts || []).map((p: any) => [String(p.id), p]))
    posts = requestedIds
      .map((id: string) => byId.get(id))
      .filter(Boolean)
      .map((p: any) => ({
        ...p,
        id: String(p.id),
        community_members_only: p.community_members_only === true,
        effective_sort_date: p.sent_at,
        is_saved: savedIdSet.has(String(p.id)),
      }))
  } else {
    const { data: rpcPosts, error: postsError } = await supabase.rpc('get_stabilized_feed', {
      p_session_start: session_start,
      p_last_effective_date: last_effective_date || null,
      p_last_id: last_id || null,
      p_limit: 50,
      p_filter_email: filterEmail
    })

    if (postsError) {
      console.error('[ranked-feed] get_stabilized_feed error:', postsError.message)
      return c.json({ data: [], meta: { next_cursor: null } })
    }
    posts = rpcPosts
  }

  if (!posts || posts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

  const visiblePosts = viewerIsRecruiter
    ? posts.filter((p: any) => p.community_members_only !== true)
    : posts

  if (visiblePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

  let lastBatchTail = visiblePosts[visiblePosts.length - 1]
  let cursorForPagination = (lastBatchTail && !requestedIds) ? {
    last_effective_date: lastBatchTail.effective_sort_date,
    last_id: lastBatchTail.id,
    session_start: session_start
  } : null

  let sourcePosts = (excludeEmail && !targetUserId)
    ? visiblePosts.filter((p: any) => p.post_type !== null && p.post_type !== 'email')
    : visiblePosts

  if (excludeEmail && !targetUserId && !requestedIds) {
    const TARGET = 50
    const MAX_EXTRA = 10
    let extraFetches = 0

    while (sourcePosts.length < TARGET && cursorForPagination && extraFetches < MAX_EXTRA) {
      extraFetches++
      const { data: morePosts } = await supabase.rpc('get_stabilized_feed', {
        p_session_start: session_start,
        p_last_effective_date: cursorForPagination.last_effective_date,
        p_last_id: cursorForPagination.last_id,
        p_limit: 50,
        p_filter_email: filterEmail
      })

      if (!morePosts || morePosts.length === 0) { cursorForPagination = null; break }

      const moreVisible = viewerIsRecruiter
        ? morePosts.filter((p: any) => p.community_members_only !== true)
        : morePosts

      sourcePosts = [
        ...sourcePosts,
        ...moreVisible.filter((p: any) => p.post_type !== null && p.post_type !== 'email')
      ]

      const tail = moreVisible[moreVisible.length - 1]
      cursorForPagination = tail ? {
        last_effective_date: tail.effective_sort_date,
        last_id: tail.id,
        session_start: session_start
      } : null
    }
  }

  if (sourcePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

  const postIds = sourcePosts.map((p: any) => p.id)

  const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const [allComments, allPostLikes, impressionsRes, connectionsRes, authUserRes] = await Promise.all([
    fetchAllByIds(supabase, 'comments', '*', 'post_id', postIds,
      (q: any) => q.lte('created_at', session_start)),
    fetchAllByIds(supabase, 'likes', 'target_id, user_id, reaction_type, created_at', 'target_id', postIds),
    current_user_uuid
      ? supabase
          .from('post_impressions')
          .select('post_id, last_seen_at')
          .eq('user_id', current_user_uuid)
          .in('post_id', postIds)
      : Promise.resolve({ data: [] }),
    current_user_uuid
      ? supabase
          .from('connections')
          .select('requester_id, receiver_id')
          .or(`requester_id.eq.${current_user_uuid},receiver_id.eq.${current_user_uuid}`)
          .eq('status', 'accepted')
      : Promise.resolve({ data: [] }),
    current_user_uuid
      ? supabaseAdmin.from('user_activity').select('last_feed_visit_at').eq('user_id', current_user_uuid).maybeSingle()
      : Promise.resolve({ data: null })
  ])

  // last-visit baseline: cap at 48h — returning users after long absence get a fresh start
  const MAX_LOOKBACK_MS = 48 * 3_600_000
  const lookbackFloor = new Date(Date.now() - MAX_LOOKBACK_MS).toISOString()
  const rawLastVisit = authUserRes?.data?.last_feed_visit_at ?? null
  const cappedLastLoginAt: string | null = rawLastVisit && rawLastVisit > lookbackFloor ? rawLastVisit : null

  // fire-and-forget: רק בטעינת פיד ראשונה (לא pagination ולא ids mode)
  if (current_user_uuid && !last_effective_date && !last_id && !requestedIds) {
    supabaseAdmin.rpc('record_feed_visit', { p_user_id: current_user_uuid })
  }

  allComments.sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))

  // A post may have multiple impression rows (one per day) — keep only the most recent last_seen_at
  const lastSeenMap: Record<string, string | null> = {}
  ;(impressionsRes.data || []).forEach((i: any) => {
    const key = String(i.post_id)
    const val = i.last_seen_at ?? null
    if (!lastSeenMap[key] || (val && val > lastSeenMap[key]!)) {
      lastSeenMap[key] = val
    }
  })

  const connectedUuids = new Set<string>(
    (connectionsRes.data || []).map((conn: any) =>
      conn.requester_id === current_user_uuid ? conn.receiver_id : conn.requester_id
    ).filter(Boolean)
  )

  const visibleComments = viewerIsRecruiter
    ? allComments.filter((cm: any) => cm.community_members_only !== true)
    : allComments

  const commentIds = visibleComments.map((cm: any) => cm.id.toString())
  const allCommentLikes = commentIds.length > 0
    ? await fetchAllByIds(supabase, 'likes', 'target_id, user_id, reaction_type', 'target_id', commentIds)
    : []

  const emailsToFetch = new Set<string>()
  sourcePosts.forEach((p: any) => { if (p.sender) emailsToFetch.add(p.sender) })
  visibleComments.forEach((cm: any) => { if (cm.sender) emailsToFetch.add(cm.sender) })

  const uniqueEmails = Array.from(emailsToFetch)
  const PROJECT_URL = Deno.env.get('SUPABASE_URL')
  const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`
  const profileRes = await fetch(PROFILE_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': c.req.header('Authorization') || '',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ emails: uniqueEmails })
  })
  if (!profileRes.ok) {
    console.error('[ranked-feed] Failed to fetch profiles:', await profileRes.text())
    return c.json({ error: 'Failed to fetch user profiles' }, 500)
  }

  const enrichedUsers = await profileRes.json()
  const usersByEmail = new Map()
  const usersByUuid = new Map()
  enrichedUsers.forEach((u: any) => {
    if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u)
    if (u.uuid) usersByUuid.set(u.uuid, u)
  })

  const viewerProfile = current_user_uuid ? usersByUuid.get(current_user_uuid) : null
  const viewerEmail: string | null = viewerProfile?._internal_email_lookup?.toLowerCase() ?? null
  const authoredPostIds = viewerEmail
    ? sourcePosts
        .filter((p: any) => (p.sender || '').toLowerCase() === viewerEmail)
        .map((p: any) => String(p.id))
    : []

  const impressionCountMap = new Map<string, number>()
  if (authoredPostIds.length > 0) {
    const supabaseAdminForCounts = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: impData } = await supabaseAdminForCounts
      .rpc('get_impression_counts', { p_post_ids: authoredPostIds })
    ;(impData || []).forEach((row: any) =>
      impressionCountMap.set(String(row.post_id), Number(row.impression_count))
    )
  }

  const companyIdsInFeed = [...new Set(sourcePosts.map((p: any) => p.company_id).filter(Boolean))] as number[]
  const companiesById = new Map<number, any>()
  if (companyIdsInFeed.length > 0) {
    const { data: companiesData } = await supabase.from('companies').select('id, name, logo').in('id', companyIdsInFeed)
    ;(companiesData || []).forEach((co: any) => companiesById.set(Number(co.id), co))
  }

  const linkedArticleIds = [...new Set(sourcePosts.map((p: any) => p.linked_article_id).filter(Boolean))] as string[]
  const linkedArticlesById = new Map<string, any>()
  if (linkedArticleIds.length > 0) {
    const { data: linkedArticlesData } = await supabase
      .from('articles')
      .select('id, title, cover_image_url, excerpt, read_time')
      .in('id', linkedArticleIds)
      .eq('status', 'published')
      .is('deleted_at', null)
    ;(linkedArticlesData || []).forEach((a: any) => linkedArticlesById.set(String(a.id), a))
  }

  const enrichedCommentsList = visibleComments.map((comment: any) => {
    const senderEmail = comment.sender
    const profileData = usersByEmail.get(senderEmail?.toLowerCase())
    let author
    if (profileData) {
      const isAnonymous = profileData.is_anonymous === true
      const { _internal_email_lookup, email: _commentAuthorEmail, ...cleanProfile } = profileData
      author = { ...cleanProfile, first_name: cleanProfile.first_name, last_name: cleanProfile.last_name, is_anonymous: isAnonymous }
    } else {
      author = { first_name: senderEmail, last_name: null, image: null, is_anonymous: false }
    }
    const commentLikes = (allCommentLikes || []).filter((l: any) => l.target_id === comment.id.toString())
    const reactionCounts = commentLikes.reduce((acc: any, like: any) => {
      const type = like.reaction_type || 'like'; acc[type] = (acc[type] || 0) + 1; return acc
    }, {})
    const userReactions = commentLikes
      .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
      .map((l: any) => l.reaction_type)
    const seenCRU = new Set<string>()
    const reactionUsers = commentLikes
      .filter((l: any) => {
        const uid = l?.user_id
        if (uid === null || uid === undefined) return false
        const s = String(uid)
        if (seenCRU.has(s)) return false
        seenCRU.add(s); return true
      })
      .map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))
    const { sender: _cs, ...commentWithoutSender } = comment
    return {
      ...commentWithoutSender,
      attachments: normalizeAttachments(comment.attachments),
      author,
      likes_count: commentLikes.length,
      reaction_users: reactionUsers,
      reaction_counts: reactionCounts,
      user_reactions: userReactions,
      user_reaction: userReactions[0] || null,
      is_liked: userReactions.length > 0
    }
  })

  const topLevelByPostId: any = {}
  const repliesByParentId: any = {}
  for (const cm of enrichedCommentsList) {
    if (cm.parent_comment_id) {
      const pid = String(cm.parent_comment_id)
      if (!repliesByParentId[pid]) repliesByParentId[pid] = []
      repliesByParentId[pid].push(cm)
    } else {
      if (!topLevelByPostId[cm.post_id]) topLevelByPostId[cm.post_id] = []
      topLevelByPostId[cm.post_id].push(cm)
    }
  }
  const commentsByPostId: any = {}
  for (const pid of Object.keys(topLevelByPostId)) {
    commentsByPostId[pid] = topLevelByPostId[pid].map((cm: any) => ({
      ...cm,
      replies: repliesByParentId[String(cm.id)] || []
    }))
  }

  // per-request derived values
  const recentActivityCutoff = new Date(Date.now() - FEED_SCORE.tier1WindowMs).toISOString()
  const isProfileFeed = !!targetUserId
  // profile feed keeps chronological order; ids mode keeps the caller's ranking order
  const skipRanking = isProfileFeed || !!requestedIds

  const scoreCtx: ScoreContext = {
    lastSeenMap, cappedLastLoginAt, session_start,
    impressionCountMap, connectedUuids,
    usersByEmail, usersByUuid,
    recentActivityCutoff,
  }

  // ── Enrich + score each post ──────────────────────────────────────────
  const scoredPosts = sourcePosts.map((post: any) => {
    const postLikes    = allPostLikes.filter((l: any)  => l.target_id === post.id)
    const postComments = visibleComments.filter((cm: any) => cm.post_id  === post.id)

    // author
    const senderEmail = post.sender
    const profileData = usersByEmail.get(senderEmail?.toLowerCase())
    let postAuthor
    if (post.company_id && companiesById.has(Number(post.company_id))) {
      postAuthor = buildCompanyAuthor(companiesById.get(Number(post.company_id))!)
    } else if (profileData) {
      const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData
      postAuthor = { ...cleanProfile, is_anonymous: profileData.is_anonymous === true }
    } else {
      postAuthor = { first_name: senderEmail, last_name: null, image: null, is_anonymous: false }
    }

    // reactions
    const reactionCounts = postLikes.reduce((acc: any, like: any) => {
      const type = like.reaction_type || 'like'; acc[type] = (acc[type] || 0) + 1; return acc
    }, {})
    const userReactions = postLikes
      .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
      .map((l: any) => l.reaction_type)
    const seenPRU = new Set<string>()
    const reactionUsers = postLikes
      .filter((l: any) => {
        const uid = l?.user_id
        if (uid === null || uid === undefined) return false
        const s = String(uid)
        if (seenPRU.has(s)) return false
        seenPRU.add(s); return true
      })
      .map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))

    const { sender: _ps, ...postWithoutSender } = post
    const linkedArticle = post.linked_article_id
      ? linkedArticlesById.get(String(post.linked_article_id)) ?? null
      : null

    // scoring
    const { score: _score, tier1: _tier1, v2 } = !skipRanking
      ? scorePost(post, postLikes, postComments, scoreCtx)
      : { score: 0, tier1: false, v2: {} }

    return {
      ...postWithoutSender,
      ...(post.company_id ? { is_company_post: true } : {}),
      attachments: normalizeAttachments(post.attachments),
      author: postAuthor,
      comments: commentsByPostId[post.id] || [],
      likes_count: postLikes.length,
      reaction_users: reactionUsers,
      reaction_counts: reactionCounts,
      user_reactions: userReactions,
      user_reaction: userReactions[0] || null,
      is_liked: userReactions.length > 0,
      impressions_count: impressionCountMap.has(String(post.id))
        ? impressionCountMap.get(String(post.id))
        : undefined,
      ...(linkedArticle ? { linked_article: linkedArticle } : {}),
      ...v2,
      _score,
      _tier1,
    }
  })

  if (!skipRanking) {
    scoredPosts.sort((a: any, b: any) => {
      if (a._tier1 !== b._tier1) return a._tier1 ? -1 : 1
      return (b._score ?? 0) - (a._score ?? 0)
    })
  }

  const postsToReturn = scoredPosts.map(({ _score, _tier1, ...p }: any) => p)

  return c.json({ data: postsToReturn, meta: { next_cursor: cursorForPagination, count: postsToReturn.length } })
}

// ====================================================================
// 2. נתיבי API
// ====================================================================

app.get('/', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const current_user_uuid = currentUser?.id
    const viewerIsRecruiter = isRecruiterViewer(currentUser)

    const last_effective_date = c.req.query('last_effective_date')
    const last_id = c.req.query('last_id')
    const session_start = c.req.query('session_start') || new Date().toISOString()

    const targetUserId = c.req.query('userid') // ה-ID שקיבלנו ב-Query
    const excludeEmail = c.req.query('exclude_email') === 'true'
    const activityFilter = c.req.query('activity_filter') // 'commented_by' | 'reacted_by'
    let filterEmail = null

if (targetUserId) {
      const { data: email, error: emailError } = await supabase
        .rpc('get_user_email_by_uuid', { p_uuid: targetUserId })

      if (emailError || !email) {
        console.error("Error fetching email:", emailError)
        // אם לא מצאנו אימייל למשתמש הזה, נחזיר פיד ריק
        return c.json({ data: [], meta: { next_cursor: null } })
      }
      filterEmail = email
    }

    // ---- Activity filter path: posts user commented on / reacted to ----
    if (activityFilter && targetUserId && filterEmail) {
      console.log(`[activity_filter] filter=${activityFilter} userId=${targetUserId} email=${filterEmail}`)
      const LIMIT = 20
      const activityMeta: Array<{ post_id: string; activity_date: string; reaction_type?: string }> = []

      // Use service-role to bypass any RLS restrictions on activity queries
      const supabaseAdminActivity = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )

      if (activityFilter === 'commented_by') {
        let q = supabaseAdminActivity
          .from('comments')
          .select('post_id, created_at')
          .ilike('sender', filterEmail) // case-insensitive match
          .order('created_at', { ascending: false })
          .limit(60) // fetch extra to handle dedup across repeated comments on same post
        if (last_effective_date) q = q.lt('created_at', last_effective_date)
        const { data: rows, error } = await q
        if (error) {
          console.error('[activity_filter] commented_by query error:', error.message)
          throw error
        }
        console.log(`[activity_filter] commented_by rows found: ${rows?.length ?? 0}`)
        const seen = new Set<string>()
        for (const r of (rows || [])) {
          if (activityMeta.length >= LIMIT + 1) break
          const pid = String(r.post_id)
          if (!seen.has(pid)) {
            seen.add(pid)
            activityMeta.push({ post_id: pid, activity_date: r.created_at })
          }
        }
      } else if (activityFilter === 'reacted_by') {
        let q = supabaseAdminActivity
          .from('likes')
          .select('target_id, reaction_type, created_at')
          .eq('user_id', targetUserId)
          .eq('target_type', 'post')
          .order('created_at', { ascending: false })
          .limit(LIMIT + 1)
        if (last_effective_date) q = q.lt('created_at', last_effective_date)
        const { data: rows, error } = await q
        if (error) {
          console.error('[activity_filter] reacted_by query error:', error.message)
          throw error
        }
        console.log(`[activity_filter] reacted_by rows found: ${rows?.length ?? 0}`)
        for (const r of (rows || [])) {
          if (activityMeta.length >= LIMIT + 1) break
          activityMeta.push({ post_id: String(r.target_id), activity_date: r.created_at, reaction_type: r.reaction_type })
        }
      }

      console.log(`[activity_filter] activityMeta count: ${activityMeta.length}`)
      if (activityMeta.length === 0) {
        return c.json({ data: [], meta: { next_cursor: null } })
      }

      const hasMoreActivity = activityMeta.length > LIMIT
      const pageActivity = hasMoreActivity ? activityMeta.slice(0, LIMIT) : activityMeta
      const lastActivityItem = pageActivity[pageActivity.length - 1]
      const activityNextCursor = hasMoreActivity && lastActivityItem
        ? { last_effective_date: lastActivityItem.activity_date, last_id: lastActivityItem.post_id }
        : null

      const activityDateMap = new Map(pageActivity.map(a => [a.post_id, a.activity_date]))
      const reactionTypeMap = new Map(pageActivity.map(a => [a.post_id, a.reaction_type]))
      const activityPostIdList = pageActivity.map(a => a.post_id)

      const { data: rawActivityPosts, error: rawActivityError } = await supabaseAdminActivity
        .from('posts')
        .select('*')
        .in('id', activityPostIdList)
      if (rawActivityError) {
        console.error('[activity_filter] failed to fetch posts:', rawActivityError.message, { activityPostIdList })
        throw rawActivityError
      }
      console.log(`[activity_filter] posts fetched: ${rawActivityPosts?.length ?? 0} for IDs: ${activityPostIdList.join(',')}`)

      const activitySourcePosts = (rawActivityPosts || []).filter((p: any) => {
        // Exclude posts authored by the user themselves (same logic as LinkedIn —
        // own posts already appear in the "Posts" tab)
        const postSender = (p.sender || '').toLowerCase()
        if (postSender === filterEmail.toLowerCase()) return false
        if (viewerIsRecruiter && p.community_members_only === true) return false
        return true
      })
      if (activitySourcePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

      // Enrichment pipeline for activity posts
      const apIds = activitySourcePosts.map((p: any) => p.id)
      const { data: apPostLikes } = await supabase
        .from('likes').select('target_id, user_id, reaction_type').in('target_id', apIds)

      const apEmailsToFetch = new Set<string>()
      activitySourcePosts.forEach((p: any) => { if (p.sender) apEmailsToFetch.add(p.sender) })

      const { data: apComments } = await supabase
        .from('comments').select('*').in('post_id', apIds)
        .lte('created_at', session_start).order('created_at', { ascending: false }).limit(500)

      const apVisibleComments = viewerIsRecruiter
        ? (apComments || []).filter((cm: any) => cm.community_members_only !== true)
        : (apComments || [])

      const apCommentIds = apVisibleComments.map((cm: any) => cm.id.toString())
      const { data: apCommentLikes } = await supabase
        .from('likes').select('target_id, user_id, reaction_type').in('target_id', apCommentIds)

      apVisibleComments.forEach((cm: any) => apEmailsToFetch.add(cm.sender))

      const apUniqueEmails = Array.from(apEmailsToFetch)
      const AP_PROJECT_URL = Deno.env.get('SUPABASE_URL')
      const AP_PROFILE_URL = `${AP_PROJECT_URL}/functions/v1/api/profile/feed`
      const apProfileRes = await fetch(AP_PROFILE_URL, {
        method: 'POST',
        headers: { 'Authorization': c.req.header('Authorization') || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: apUniqueEmails }),
      })
      if (!apProfileRes.ok) throw new Error('Failed to fetch user profiles for activity')
      const apEnrichedUsers = await apProfileRes.json()
      const apByEmail = new Map()
      const apByUuid = new Map()
      apEnrichedUsers.forEach((u: any) => {
        if (u._internal_email_lookup) apByEmail.set(u._internal_email_lookup, u)
        if (u.uuid) apByUuid.set(u.uuid, u)
      })

      const apEnrichedComments = apVisibleComments.map((comment: any) => {
        const pd = apByEmail.get(comment.sender?.toLowerCase())
        let author
        if (pd) {
          const { _internal_email_lookup: _e1, email: _e2, ...cp } = pd
          author = { ...cp, is_anonymous: pd.is_anonymous === true }
        } else {
          author = { first_name: comment.sender, last_name: null, image: null, is_anonymous: false }
        }
        const cLikes = (apCommentLikes || []).filter((l: any) => l.target_id === comment.id.toString())
        const cReactionCounts = cLikes.reduce((acc: any, l: any) => { const t = l.reaction_type || 'like'; acc[t] = (acc[t] || 0) + 1; return acc }, {})
        const cUserReactions = cLikes.filter((l: any) => l.user_id === current_user_uuid).map((l: any) => l.reaction_type)
        const cSeen = new Set<string>()
        const cReactionUsers = cLikes.filter((l: any) => { const uid = String(l.user_id); if (cSeen.has(uid)) return false; cSeen.add(uid); return true }).map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))
        const { sender: _cs, ...commentRest } = comment
        return { ...commentRest, attachments: normalizeAttachments(comment.attachments), author, likes_count: cLikes.length, reaction_users: cReactionUsers, reaction_counts: cReactionCounts, user_reactions: cUserReactions, user_reaction: cUserReactions[0] || null, is_liked: cUserReactions.length > 0 }
      })

      const apTopLevel: any = {}
      const apReplies: any = {}
      for (const cm of apEnrichedComments) {
        if (cm.parent_comment_id) {
          const pid = String(cm.parent_comment_id)
          if (!apReplies[pid]) apReplies[pid] = []
          apReplies[pid].push(cm)
        } else {
          if (!apTopLevel[cm.post_id]) apTopLevel[cm.post_id] = []
          apTopLevel[cm.post_id].push(cm)
        }
      }
      const apCommentsByPostId: any = {}
      for (const pid of Object.keys(apTopLevel)) {
        apCommentsByPostId[pid] = apTopLevel[pid].map((cm: any) => ({ ...cm, replies: apReplies[String(cm.id)] || [] }))
      }

      const apEnrichedPosts = activitySourcePosts.map((post: any) => {
        const pLikes = (apPostLikes || []).filter((l: any) => l.target_id === post.id)
        const pd = apByEmail.get(post.sender?.toLowerCase())
        let postAuthor
        if (pd) {
          const { _internal_email_lookup: _e1, email: _e2, ...cp } = pd
          postAuthor = { ...cp, is_anonymous: pd.is_anonymous === true }
        } else {
          postAuthor = { first_name: post.sender, last_name: null, image: null, is_anonymous: false }
        }
        const pReactionCounts = pLikes.reduce((acc: any, l: any) => { const t = l.reaction_type || 'like'; acc[t] = (acc[t] || 0) + 1; return acc }, {})
        const pUserReactions = pLikes.filter((l: any) => l.user_id === current_user_uuid).map((l: any) => l.reaction_type)
        const pSeen = new Set<string>()
        const pReactionUsers = pLikes.filter((l: any) => { const uid = String(l.user_id); if (pSeen.has(uid)) return false; pSeen.add(uid); return true }).map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))
        const { sender: _ps, ...postRest } = post
        return {
          ...postRest,
          attachments: normalizeAttachments(post.attachments),
          author: postAuthor,
          comments: apCommentsByPostId?.[post.id] || [],
          likes_count: pLikes.length,
          reaction_users: pReactionUsers,
          reaction_counts: pReactionCounts,
          user_reactions: pUserReactions,
          user_reaction: pUserReactions[0] || null,
          is_liked: pUserReactions.length > 0,
          activity_type: activityFilter === 'commented_by' ? 'comment' : 'reaction',
          activity_date: activityDateMap.get(String(post.id)),
          ...(activityFilter === 'reacted_by' ? { user_activity_reaction_type: reactionTypeMap.get(String(post.id)) } : {}),
        }
      })

      apEnrichedPosts.sort((a: any, b: any) =>
        new Date(b.activity_date ?? 0).getTime() - new Date(a.activity_date ?? 0).getTime()
      )

      return c.json({ data: apEnrichedPosts, meta: { next_cursor: activityNextCursor } })
    }
    // ---- End activity filter path ----

    // Explicit post-list mode (e.g. AI search results): enrich the given ids through
    // the shared feed pipeline, regardless of the feed_ranking flag.
    if (c.req.query('ids')) {
      return handleRankedFeed(c)
    }

    // Feature flag: v2 ranked feed (hermetically separate, no effect on existing flow)
    if (c.req.query('feed_ranking') === 'v2') {
      return handleRankedFeed(c)
    }

    const { data: posts, error: postsError } = await supabase.rpc('get_stabilized_feed', {
      p_session_start: session_start,
      p_last_effective_date: last_effective_date || null,
      p_last_id: last_id || null,
      p_limit: 25,
      p_filter_email: filterEmail
    })

    if (postsError) throw postsError
    if (!posts || posts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

    // Streak/visit tracking — only on first load of the default feed (not pagination, not the v2 path).
    if (current_user_uuid && !last_effective_date && !last_id) {
      const supabaseAdminVisit = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )
      await supabaseAdminVisit.rpc('record_feed_visit', { p_user_id: current_user_uuid })
    }

    const visiblePosts = viewerIsRecruiter
      ? posts.filter((p: any) => p.community_members_only !== true)
      : posts

    if (visiblePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

    let sourcePosts = (excludeEmail && !targetUserId)
      ? visiblePosts.filter((p: any) => p.post_type !== null && p.post_type !== 'email')
      : visiblePosts

    let lastBatchTail = visiblePosts[visiblePosts.length - 1]
    let cursorForPagination = lastBatchTail ? {
      last_effective_date: lastBatchTail.effective_sort_date,
      last_id: lastBatchTail.id,
      session_start: session_start
    } : null

    // When filtering emails, cascade through extra DB pages until we have enough
    // platform posts or exhaust the feed — prevents trickle-loading 1-2 posts at a time.
    if (excludeEmail && !targetUserId) {
      const TARGET = 25
      const MAX_EXTRA = 10
      let extraFetches = 0

      while (sourcePosts.length < TARGET && cursorForPagination && extraFetches < MAX_EXTRA) {
        extraFetches++
        const { data: morePosts } = await supabase.rpc('get_stabilized_feed', {
          p_session_start: session_start,
          p_last_effective_date: cursorForPagination.last_effective_date,
          p_last_id: cursorForPagination.last_id,
          p_limit: 25,
          p_filter_email: filterEmail
        })

        if (!morePosts || morePosts.length === 0) { cursorForPagination = null; break }

        const moreVisible = viewerIsRecruiter
          ? morePosts.filter((p: any) => p.community_members_only !== true)
          : morePosts

        sourcePosts = [
          ...sourcePosts,
          ...moreVisible.filter((p: any) => p.post_type !== null && p.post_type !== 'email')
        ]

        const tail = moreVisible[moreVisible.length - 1]
        cursorForPagination = tail ? {
          last_effective_date: tail.effective_sort_date,
          last_id: tail.id,
          session_start: session_start
        } : null
      }
    }

    // If cascade found nothing, there are no more platform posts — signal end of feed.
    if (sourcePosts.length === 0) return c.json({ data: [], meta: { next_cursor: null } })

    const postIds = sourcePosts.map((p: any) => p.id)

    const allPostLikes = await fetchAllByIds(supabase, 'likes', 'target_id, user_id, reaction_type', 'target_id', postIds)

    const emailsToFetch = new Set<string>()
    sourcePosts.forEach((p: any) => {
      if (p.sender) emailsToFetch.add(p.sender)
    })

    const comments = await fetchAllByIds(supabase, 'comments', '*', 'post_id', postIds,
      (q: any) => q.lte('created_at', session_start))
    comments.sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))

    const visibleComments = viewerIsRecruiter
      ? comments.filter((c: any) => c.community_members_only !== true)
      : comments

    const commentIds = visibleComments.map((c: any) => c.id.toString())
    const allCommentLikes = commentIds.length > 0
      ? await fetchAllByIds(supabase, 'likes', 'target_id, user_id, reaction_type', 'target_id', commentIds)
      : []

    visibleComments.forEach((c: any) => emailsToFetch.add(c.sender))

    const uniqueEmails = Array.from(emailsToFetch)
    const PROJECT_URL = Deno.env.get('SUPABASE_URL')
    const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`

    const profileRes = await fetch(PROFILE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': c.req.header('Authorization') || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emails: uniqueEmails })
    })

    if (!profileRes.ok) {
      const errorText = await profileRes.text()
      console.error('Failed to fetch profiles via API:', errorText)
      console.error('Status:', profileRes.status, 'StatusText:', profileRes.statusText)
      throw new Error('Failed to fetch user profiles')
    }

    const enrichedUsers = await profileRes.json()
    
    // יצירת מפה כפולה: לפי email ולפי uuid
    const usersByEmail = new Map()
    const usersByUuid = new Map()

    enrichedUsers.forEach((u: any) => {
      if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u)
      if (u.uuid) usersByUuid.set(u.uuid, u)
    })

    // Fetch impression counts only for posts authored by the current viewer
    const viewerProfile = current_user_uuid ? usersByUuid.get(current_user_uuid) : null
    const viewerEmail: string | null = viewerProfile?._internal_email_lookup?.toLowerCase() ?? null

    const authoredPostIds = viewerEmail
      ? sourcePosts
          .filter((p: any) => (p.sender || '').toLowerCase() === viewerEmail)
          .map((p: any) => String(p.id))
      : []

    const impressionCountMap = new Map<string, number>()
    if (authoredPostIds.length > 0) {
      const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      )
      const { data: impData } = await supabaseAdmin
        .rpc('get_impression_counts', { p_post_ids: authoredPostIds })
      ;(impData || []).forEach((row: any) =>
        impressionCountMap.set(String(row.post_id), Number(row.impression_count))
      )
    }

    // Batch-fetch company data for company posts
    const companyIdsInFeed = [...new Set(sourcePosts.map((p: any) => p.company_id).filter(Boolean))] as number[]
    const companiesById = new Map<number, any>()
    if (companyIdsInFeed.length > 0) {
      const { data: companiesData } = await supabase.from('companies').select('id, name, logo').in('id', companyIdsInFeed)
      ;(companiesData || []).forEach((co: any) => companiesById.set(Number(co.id), co))
    }

    const enrichedCommentsList = visibleComments.map((comment: any) => {
      const senderEmail = comment.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase());

      let author
      if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, email: _commentAuthorEmail, ...cleanProfile } = profileData
        author = {
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        }
      } else {
        author = { first_name: senderEmail, last_name: null, image: null, is_anonymous: false }
      }

      const commentLikes = allCommentLikes?.filter((l: any) => l.target_id === comment.id.toString()) || []
      const reactionCounts = commentLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})
      const userReactions = commentLikes
        .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
        .map((l: any) => l.reaction_type)
      const seenCommentReactionUsers = new Set<string>()
      const reactionUsers = commentLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenCommentReactionUsers.has(normalizedUserId)) return false
          seenCommentReactionUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))

      const { sender, ...commentWithoutSender } = comment
      return {
        ...commentWithoutSender,
        attachments: normalizeAttachments(comment.attachments),
        author,
        likes_count: commentLikes.length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0
      }
    })

    // קינון: תגובות-על מתחת לתגובות ראשיות
    const topLevelByPostId: any = {}
    const repliesByParentId: any = {}
    for (const c of enrichedCommentsList) {
      if (c.parent_comment_id) {
        const pid = String(c.parent_comment_id)
        if (!repliesByParentId[pid]) repliesByParentId[pid] = []
        repliesByParentId[pid].push(c)
      } else {
        if (!topLevelByPostId[c.post_id]) topLevelByPostId[c.post_id] = []
        topLevelByPostId[c.post_id].push(c)
      }
    }
    const commentsByPostId: any = {}
    for (const postId of Object.keys(topLevelByPostId)) {
      commentsByPostId[postId] = topLevelByPostId[postId].map((c: any) => ({
        ...c,
        replies: repliesByParentId[String(c.id)] || []
      }))
    }

    // Batch-fetch linked articles for posts that have one
    const linkedArticleIds = [...new Set(
      sourcePosts.map((p: any) => p.linked_article_id).filter(Boolean)
    )] as string[]
    const linkedArticlesById = new Map<string, any>()
    if (linkedArticleIds.length > 0) {
      const { data: linkedArticlesData } = await supabase
        .from('articles')
        .select('id, title, cover_image_url, excerpt, read_time')
        .in('id', linkedArticleIds)
        .eq('status', 'published')
        .is('deleted_at', null)
      ;(linkedArticlesData || []).forEach((a: any) => linkedArticlesById.set(String(a.id), a))
    }

    const enrichedPosts = sourcePosts.map((post: any) => {
      const postLikes = allPostLikes?.filter((l: any) => l.target_id === post.id) || []
      const senderEmail = post.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase());

      let postAuthor
      if (post.company_id && companiesById.has(Number(post.company_id))) {
        postAuthor = buildCompanyAuthor(companiesById.get(Number(post.company_id))!)
      } else if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData

        postAuthor = {
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        }
      } else {
        postAuthor = {
          first_name: senderEmail,
          last_name: null,
          image: null,
          is_anonymous: false
        }
      }

      // ספירת ריאקציות לפי סוג
      const reactionCounts = postLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})

      // הריאקציות של המשתמש הנוכחי (מערך)
      const userReactions = postLikes
        .filter((l: any) => l.user_id === current_user_uuid || l.user_uuid === current_user_uuid)
        .map((l: any) => l.reaction_type)

      const seenPostReactionUsers = new Set<string>()
      const reactionUsers = postLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenPostReactionUsers.has(normalizedUserId)) return false
          seenPostReactionUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({
          user_id: String(l.user_id),
          reaction_type: l.reaction_type || 'like'
        }))

      const { sender, ...postWithoutSender } = post
      const linkedArticle = post.linked_article_id
        ? linkedArticlesById.get(String(post.linked_article_id)) ?? null
        : null
      return {
        ...postWithoutSender,
        ...(post.company_id ? { is_company_post: true } : {}),
        attachments: normalizeAttachments(post.attachments),
        author: postAuthor,
        comments: commentsByPostId?.[post.id] || [],
        likes_count: postLikes.length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0,
        impressions_count: impressionCountMap.has(String(post.id))
          ? impressionCountMap.get(String(post.id))
          : undefined,
        ...(linkedArticle ? { linked_article: linkedArticle } : {}),
      }
    })

    return c.json({ data: enrichedPosts, meta: { next_cursor: cursorForPagination, count: enrichedPosts.length } })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/new-count', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const viewerIsRecruiter = isRecruiterViewer(currentUser)

    const since = c.req.query('since')
    const excludeEmail = c.req.query('exclude_email') === 'true'

    if (!since) return c.json({ error: 'since param required' }, 400)

    let query = supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .gt('sent_at', since)

    if (excludeEmail) {
      query = query.not('post_type', 'is', null).neq('post_type', 'email')
    }

    if (viewerIsRecruiter) {
      query = query.neq('community_members_only', true)
    }

    const { count, error } = await query
    if (error) throw error

    return c.json({ count: count ?? 0 })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// ADMIN: BACKFILL VECTORS FOR HTML POSTS
// ====================================================================

app.post('/admin/backfill-vectors', async (c) => {
  const user = c.get('user')
  if (!user?.app_metadata?.is_admin) return c.json({ error: 'Forbidden' }, 403)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { data: posts, error } = await supabaseAdmin
    .from('posts')
    .select('id')
    .like('message', '%<%>%')
    .not('post_type', 'is', null)

  if (error) return c.json({ error: error.message }, 500)

  const ids = (posts || []).map((p: any) => p.id)

  for (const id of ids) {
    await updatePostVector(id)
  }

  return c.json({ success: true, updated: ids.length })
})

// ====================================================================
// SCHEDULED POSTS — GET / PUT / DELETE (must be before /:id)
// ====================================================================

app.get('/scheduled', async (c) => {
  try {
    const supabase = c.get('supabase')
    if (!supabase) return c.json({ error: 'Unauthorized' }, 401)

    const { data, error } = await supabase
      .from('scheduled_posts')
      .select('id, subject, message, post_type, scheduled_at, attachments, community_members_only, company_id, linked_article_id, created_at')
      .order('scheduled_at', { ascending: true })

    if (error) throw error
    return c.json({ data: data ?? [] })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.put('/scheduled/:id', async (c) => {
  try {
    const supabase = c.get('supabase')
    if (!supabase) return c.json({ error: 'Unauthorized' }, 401)

    const scheduledPostId = c.req.param('id')
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const { data: existing, error: fetchError } = await supabase
      .from('scheduled_posts')
      .select('attachments')
      .eq('id', scheduledPostId)
      .single()

    if (fetchError?.code === 'PGRST116' || !existing) {
      return c.json({ error: 'This post has already been published or does not exist' }, 404)
    }
    if (fetchError) throw fetchError

    const updateData: any = {}
    if (body.message !== undefined) {
      if (plainTextLength(body.message) > 3000) return c.json({ error: 'Message too long' }, 400)
      updateData.message = body.message
    }
    if (body.subject !== undefined) {
      if (body.subject.length > 150) return c.json({ error: 'Subject too long' }, 400)
      updateData.subject = body.subject
    }
    if (body.post_type !== undefined) {
      if (!VALID_POST_TYPES.has(body.post_type)) return c.json({ error: 'Invalid post_type' }, 400)
      updateData.post_type = body.post_type
    }
    const communityMembersOnlyInput = body.community_members_only ?? body.communityMembersOnly
    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400)
      }
      updateData.community_members_only = communityMembersOnlyInput
    }
    if (body.scheduled_at !== undefined) {
      const newDate = new Date(body.scheduled_at)
      if (isNaN(newDate.getTime()) || newDate <= new Date()) {
        return c.json({ error: 'scheduled_at must be a valid future timestamp' }, 400)
      }
      updateData.scheduled_at = newDate.toISOString()
    }

    // Attachment cleanup — remove storage files no longer referenced
    let filesToDelete: string[] = []
    if (body.attachments !== undefined) {
      const normalizedNew = normalizeAttachments(body.attachments) || []
      const cleanedNew = normalizedNew.map((a: any) => {
        if (!a || typeof a === 'string') return a
        const p = toStoragePath(a)
        if (p) return { ...a, localPath: p }
        return a
      })
      updateData.attachments = cleanedNew
      const newIdentifiers = cleanedNew.map((a: any) => toStoragePath(a)).filter(Boolean) as string[]
      if (newIdentifiers.length > 0) {
        for (const oldAtt of (existing.attachments || [])) {
          const oldPath = toStoragePath(oldAtt)
          if (oldPath && !newIdentifiers.includes(oldPath)) filesToDelete.push(oldPath)
        }
      }
    }

    const { data, error } = await supabase
      .from('scheduled_posts').update(updateData).eq('id', scheduledPostId).select().single()
    if (error) throw error

    if (filesToDelete.length > 0) {
      const { error: storageErr } = await supabase.storage.from('attachments').remove(filesToDelete)
      if (storageErr) console.error('Failed to delete old files from storage:', storageErr)
    }

    return c.json({ success: true, data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/scheduled/:id', async (c) => {
  try {
    const supabase = c.get('supabase')
    if (!supabase) return c.json({ error: 'Unauthorized' }, 401)

    const scheduledPostId = c.req.param('id')

    const { data: existing, error: fetchError } = await supabase
      .from('scheduled_posts')
      .select('attachments')
      .eq('id', scheduledPostId)
      .single()

    if (fetchError?.code === 'PGRST116' || !existing) {
      return c.json({ error: 'Scheduled post not found' }, 404)
    }
    if (fetchError) throw fetchError

    const { error } = await supabase
      .from('scheduled_posts').delete().eq('id', scheduledPostId)
    if (error) throw error

    // Delete attachment files from Storage
    const attachmentPaths = (existing.attachments || [])
      .map((a: any) => {
        if (typeof a === 'string') return null
        if (a.localPath) return a.localPath
        if (a.url) {
          const parts = a.url.split('/attachments/')
          return parts.length > 1 ? parts[1] : null
        }
        return null
      })
      .filter(Boolean) as string[]

    if (attachmentPaths.length > 0) {
      const { error: storageErr } = await supabase.storage.from('attachments').remove(attachmentPaths)
      if (storageErr) console.error('Failed to delete scheduled post files from storage:', storageErr)
    }

    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ====================================================================
// PUBLISH SCHEDULED — internal endpoint called by cron Edge Function
// ====================================================================

app.post('/publish-scheduled', async (c) => {
  try {
    const authHeader = c.req.header('Authorization')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!authHeader || authHeader !== `Bearer ${serviceRoleKey}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }

    const { scheduled_post_id } = body
    if (!scheduled_post_id) return c.json({ error: 'scheduled_post_id is required' }, 400)

    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: sp, error: fetchErr } = await supabaseAdmin
      .from('scheduled_posts')
      .select('*')
      .eq('id', scheduled_post_id)
      .single()

    if (fetchErr?.code === 'PGRST116' || !sp) {
      return c.json({ skipped: true, reason: 'already published or not found' })
    }
    if (fetchErr) throw fetchErr

    // 1. Insert into posts — ON CONFLICT DO NOTHING handles duplicate cron runs
    const { error: insertError } = await supabaseAdmin
      .from('posts')
      .insert({
        id: sp.id,
        sender: sp.sender,
        subject: sp.subject,
        message: sp.message,
        attachments: sp.attachments,
        sent_at: sp.scheduled_at,
        post_type: sp.post_type,
        community_members_only: sp.community_members_only,
        ...(sp.company_id ? { company_id: sp.company_id, posted_by_uuid: sp.posted_by_uuid } : { posted_by_uuid: sp.posted_by_uuid }),
        ...(sp.linked_article_id ? { linked_article_id: sp.linked_article_id } : {}),
      })
      .select()
      .single()

    // Duplicate key = already published (concurrent cron run) — still clean up
    if (insertError && insertError.code !== '23505') throw insertError

    // 2. Mention notifications — sent at actual publish time
    await insertMentionNotifications(supabaseAdmin, sp.message, sp.posted_by_uuid, sp.id)

    // 3. Vector embedding (fire-and-forget)
    updatePostVector(sp.id)

    // 4. Delete from scheduled_posts
    await supabaseAdmin.from('scheduled_posts').delete().eq('id', sp.id)

    return c.json({ success: true })
  } catch (err: any) {
    console.error('[publish-scheduled] error:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

app.get('/:id', async (c) => {
  try {
    const supabase = c.get('supabase')
    const currentUser = c.get('user')
    const currentUserUuid = currentUser?.id
    const viewerIsRecruiter = isRecruiterViewer(currentUser)
    const postId = c.req.param('id')

    if (!postId) return c.json({ error: 'Post ID is required' }, 400)

    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .single()

    if (postError) {
      if (postError.code === 'PGRST116') {
        return c.json({ error: 'Post not found' }, 404)
      }
      throw postError
    }

    if (viewerIsRecruiter && post.community_members_only === true) {
      return c.json({ error: 'Post not found' }, 404)
    }

    const { data: postLikes } = await supabase
      .from('likes')
      .select('target_id, user_id, reaction_type')
      .eq('target_id', post.id)

    const { data: savedRow } = await supabase
      .from('saved_resources')
      .select('id')
      .eq('user_id', currentUserUuid)
      .eq('saved_resource_type', 'post')
      .eq('saved_resource_id', String(post.id))
      .maybeSingle()

    const { data: commentsRaw } = await supabase
      .from('comments')
      .select('*')
      .eq('post_id', post.id)
      .order('created_at', { ascending: true })

    const comments = viewerIsRecruiter
      ? (commentsRaw || []).filter((c: any) => c.community_members_only !== true)
      : (commentsRaw || [])

    const commentIds = comments.map((c: any) => c.id.toString())
    const { data: commentLikes } = commentIds.length > 0
      ? await supabase
          .from('likes')
          .select('target_id, user_id, reaction_type')
          .in('target_id', commentIds)
      : { data: [] as any[] }

    const emailsToFetch = new Set<string>()
    if (post.sender) emailsToFetch.add(post.sender)
    comments.forEach((comment: any) => {
      if (comment.sender) emailsToFetch.add(comment.sender)
    })

    const uniqueEmails = Array.from(emailsToFetch)
    const PROJECT_URL = Deno.env.get('SUPABASE_URL')
    const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`

    const profileRes = await fetch(PROFILE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': c.req.header('Authorization') || '',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emails: uniqueEmails })
    })

    if (!profileRes.ok) {
      const errorText = await profileRes.text()
      console.error('Failed to fetch profiles via API:', errorText)
      throw new Error('Failed to fetch user profiles')
    }

    const enrichedUsers = await profileRes.json()
    const usersByEmail = new Map()
    enrichedUsers.forEach((u: any) => {
      if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u)
    })

    // Fetch company data if this is a company post
    let postCompany: { name: string; logo?: string | null } | null = null
    if (post.company_id) {
      const { data: co } = await supabase.from('companies').select('id, name, logo').eq('id', post.company_id).maybeSingle()
      postCompany = co
    }

    // Fetch linked article if present
    let linkedArticle: any = null
    if (post.linked_article_id) {
      const { data: article } = await supabase
        .from('articles')
        .select('id, title, cover_image_url, excerpt, read_time')
        .eq('id', post.linked_article_id)
        .eq('status', 'published')
        .is('deleted_at', null)
        .maybeSingle()
      linkedArticle = article ?? null
    }

    const allEnrichedComments = comments.map((comment: any) => {
      const senderEmail = comment.sender
      const profileData = usersByEmail.get(senderEmail?.toLowerCase())

      let author
      if (profileData) {
        const isAnonymous = profileData.is_anonymous === true
        const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData
        author = { ...cleanProfile, first_name: cleanProfile.first_name, last_name: cleanProfile.last_name, is_anonymous: isAnonymous }
      } else {
        author = { first_name: senderEmail, last_name: null, image: null, is_anonymous: false }
      }

      const currentCommentLikes = (commentLikes || []).filter((l: any) => l.target_id === comment.id.toString())
      const reactionCounts = currentCommentLikes.reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like'
        acc[type] = (acc[type] || 0) + 1
        return acc
      }, {})
      const userReactions = currentCommentLikes
        .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
        .map((l: any) => l.reaction_type)
      const seenUsers = new Set<string>()
      const reactionUsers = currentCommentLikes
        .filter((l: any) => {
          const userId = l?.user_id
          if (userId === null || userId === undefined) return false
          const normalizedUserId = String(userId)
          if (seenUsers.has(normalizedUserId)) return false
          seenUsers.add(normalizedUserId)
          return true
        })
        .map((l: any) => ({ user_id: String(l.user_id), reaction_type: l.reaction_type || 'like' }))

      const { sender, ...commentWithoutSender } = comment
      return {
        ...commentWithoutSender,
        attachments: normalizeAttachments(comment.attachments),
        author,
        likes_count: currentCommentLikes.length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0
      }
    })

    // קינון: תגובות-על מתחת לתגובות ראשיות
    const repliesByParentId: any = {}
    const topLevelComments: any[] = []
    for (const c of allEnrichedComments) {
      if (c.parent_comment_id) {
        const pid = String(c.parent_comment_id)
        if (!repliesByParentId[pid]) repliesByParentId[pid] = []
        repliesByParentId[pid].push(c)
      } else {
        topLevelComments.push(c)
      }
    }
    const commentsEnriched = topLevelComments.map((c: any) => ({
      ...c,
      replies: repliesByParentId[String(c.id)] || []
    }))

    const senderEmail = post.sender
    const profileData = usersByEmail.get(senderEmail?.toLowerCase())
    let postAuthor

    if (postCompany) {
      postAuthor = buildCompanyAuthor(postCompany)
    } else if (profileData) {
      const isAnonymous = profileData.is_anonymous === true
      const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData
      postAuthor = {
        ...cleanProfile,
        first_name: cleanProfile.first_name,
        last_name: cleanProfile.last_name,
        is_anonymous: isAnonymous
      }
    } else {
      postAuthor = {
        first_name: senderEmail,
        last_name: null,
        image: null,
        is_anonymous: false
      }
    }

    const reactionCounts = (postLikes || []).reduce((acc: any, like: any) => {
      const type = like.reaction_type || 'like'
      acc[type] = (acc[type] || 0) + 1
      return acc
    }, {})

    const userReactions = (postLikes || [])
      .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
      .map((l: any) => l.reaction_type)

    const seenPostUsers = new Set<string>()
    const reactionUsers = (postLikes || [])
      .filter((l: any) => {
        const userId = l?.user_id
        if (userId === null || userId === undefined) return false
        const normalizedUserId = String(userId)
        if (seenPostUsers.has(normalizedUserId)) return false
        seenPostUsers.add(normalizedUserId)
        return true
      })
      .map((l: any) => ({
        user_id: String(l.user_id),
        reaction_type: l.reaction_type || 'like'
      }))

    const { sender, ...postWithoutSender } = post

    return c.json({
      success: true,
      data: {
        ...postWithoutSender,
        ...(post.company_id ? { is_company_post: true } : {}),
        attachments: normalizeAttachments(post.attachments),
        author: postAuthor,
        comments: commentsEnriched,
        likes_count: (postLikes || []).length,
        reaction_users: reactionUsers,
        reaction_counts: reactionCounts,
        user_reactions: userReactions,
        user_reaction: userReactions[0] || null,
        is_liked: userReactions.length > 0,
        is_saved: !!savedRow,
        saved_id: savedRow?.id ?? null,
        ...(linkedArticle ? { linked_article: linkedArticle } : {})
      }
    })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/', async (c) => {
  try {
    const supabase = c.get('supabase')
    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    if (Array.isArray(body)) {
      let processed = 0;
      for (const msg of body) {
        try {
          const senderEmail = msg.sender?.toLowerCase().trim();
          if (!senderEmail) continue;
          const normalizedAttachments = normalizeAttachments(msg.attachments);

          const postId = await deterministicInt8(msg.googleThreadId);
          const messageUniqueId = msg.googleMessageId;

          const { data: existingPost } = await supabaseAdmin.from("posts").select("id").eq("id", postId).maybeSingle();
          const threadExists = !!existingPost;

          if (threadExists && msg.googleThreadId !== messageUniqueId) {
            const commentId = await deterministicInt8(messageUniqueId + senderEmail);
            await supabaseAdmin.from("comments").upsert({
              id: commentId,
              post_id: postId,
              sender: senderEmail,
              message: msg.message || "",
              attachments: normalizedAttachments,
              community_members_only: typeof msg.community_members_only === 'boolean' ? msg.community_members_only : false,
              created_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString()
            });
            await updatePostVector(postId);
          } else {
            await supabaseAdmin.from("posts").upsert({
              id: postId,
              sender: senderEmail,
              subject: msg.subject || "",
              message: msg.message || "",
              attachments: normalizedAttachments,
              sent_at: msg.sentAt ? new Date(msg.sentAt).toISOString() : new Date().toISOString(),
              post_type: msg.post_type,
              community_members_only: typeof msg.community_members_only === 'boolean' ? msg.community_members_only : false
            });
            await updatePostVector(postId);
          }
          processed++;
        } catch (innerErr) {
          console.error("Error processing script item:", innerErr);
        }
      }
      return c.json({ success: true, processed, mode: "script" });
    } else {
      const user = c.get('user');
      if (!user) return c.json({ error: "Unauthorized" }, 401);

      const { subject, message, attachments, post_type } = body;
      const communityMembersOnlyInput = body.community_members_only ?? body.communityMembersOnly;
      const company_id = body.company_id ? Number(body.company_id) : null;
      const linked_article_id = body.linked_article_id ? String(body.linked_article_id) : null;

      if (post_type !== undefined && !VALID_POST_TYPES.has(post_type)) {
        return c.json({ error: 'Invalid post_type' }, 400);
      }

      if (communityMembersOnlyInput !== undefined && typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400);
      }

      const community_members_only = communityMembersOnlyInput === true;

      // Validate company ownership when posting as a company
      if (company_id) {
        const { data: companyCheck, error: companyCheckError } = await supabaseAdmin
          .from('companies')
          .select('id, owner_uuid')
          .eq('id', company_id)
          .maybeSingle()
        if (companyCheckError || !companyCheck) {
          return c.json({ error: "Company not found" }, 404);
        }
        if (companyCheck.owner_uuid !== user.id) {
          return c.json({ error: "You don't have permission to post on behalf of this company" }, 403);
        }
      }

      if (!message) return c.json({ error: "Message is required" }, 400);
      if (plainTextLength(message) > 3000) return c.json({ error: "Message too long" }, 400);
      if (subject && subject.length > 150) return c.json({ error: "Subject too long" }, 400);

      // ── Scheduled post path ──────────────────────────────────────────
      const scheduled_at_raw = body.scheduled_at
      if (scheduled_at_raw) {
        const scheduledDate = new Date(scheduled_at_raw)
        if (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
          return c.json({ error: "scheduled_at must be a valid future timestamp" }, 400)
        }
        const threeMonthsFromNow = new Date()
        threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3)
        if (scheduledDate > threeMonthsFromNow) {
          return c.json({ error: "scheduled_at cannot be more than 3 months in the future" }, 400)
        }

        const { count: scheduledCount } = await supabaseAdmin
          .from('scheduled_posts')
          .select('id', { count: 'exact', head: true })
          .eq('posted_by_uuid', user.id)
        if ((scheduledCount ?? 0) >= 5) {
          return c.json({ error: "You've reached the 5 scheduled posts limit" }, 400)
        }

        const scheduledPostId = crypto.randomUUID()
        const normalizedScheduledAttachments = normalizeAttachments(attachments)
        const { data: scheduledData, error: scheduledError } = await supabaseAdmin
          .from('scheduled_posts')
          .insert({
            id: scheduledPostId,
            sender: user.email,
            subject: subject || "",
            message,
            attachments: normalizedScheduledAttachments,
            post_type: post_type || 'discussion',
            community_members_only,
            company_id: company_id ?? null,
            posted_by_uuid: user.id,
            linked_article_id: linked_article_id ?? null,
            scheduled_at: scheduledDate.toISOString(),
          })
          .select()
          .single()
        if (scheduledError) throw scheduledError
        return c.json({ scheduled: true, data: scheduledData })
      }
      // ── End scheduled post path ──────────────────────────────────────

      const postId = crypto.randomUUID();
      const normalizedAttachments = normalizeAttachments(attachments);

      const { data, error } = await supabase.from('posts').insert({
        id: postId,
        sender: user.email,
        subject: subject || "",
        message: message,
        attachments: normalizedAttachments,
        sent_at: new Date().toISOString(),
        post_type: post_type || 'discussion',
        community_members_only,
        ...(company_id ? { company_id, posted_by_uuid: user.id } : { posted_by_uuid: user.id }),
        ...(linked_article_id ? { linked_article_id } : {}),
      }).select().single();

      if (error) throw error;
      updatePostVector(data.id);

      await insertMentionNotifications(supabase, message, user.id, data.id);

      // enrichment: שליפת הפוסט כמו GET /:id
      // נשתמש בלוגיקה של GET /:id כדי להחזיר פוסט מועשר
      // (העתקה מה-handler של GET /:id)
      const { data: post, error: postError } = await supabase
        .from('posts')
        .select('*')
        .eq('id', data.id)
        .single();
      if (postError) throw postError;

      // enrichment (likes, comments, author, ...)
      const currentUser = c.get('user');
      const currentUserUuid = currentUser?.id;
      const viewerIsRecruiter = isRecruiterViewer(currentUser);

      const { data: postLikes } = await supabase
        .from('likes')
        .select('target_id, user_id, reaction_type')
        .eq('target_id', post.id);

      const { data: savedRow } = await supabase
        .from('saved_resources')
        .select('id')
        .eq('user_id', currentUserUuid)
        .eq('saved_resource_type', 'post')
        .eq('saved_resource_id', String(post.id))
        .maybeSingle();

      const { data: commentsRaw } = await supabase
        .from('comments')
        .select('*')
        .eq('post_id', post.id)
        .order('created_at', { ascending: true });

      const comments = viewerIsRecruiter
        ? (commentsRaw || []).filter((c: any) => c.community_members_only !== true)
        : (commentsRaw || []);

      const commentIds = comments.map((c: any) => c.id.toString());
      const { data: commentLikes } = commentIds.length > 0
        ? await supabase
            .from('likes')
            .select('target_id, user_id, reaction_type')
            .in('target_id', commentIds)
        : { data: [] as any[] };

      const emailsToFetch = new Set<string>();
      if (post.sender) emailsToFetch.add(post.sender);
      comments.forEach((comment: any) => {
        if (comment.sender) emailsToFetch.add(comment.sender);
      });

      const PROJECT_URL = Deno.env.get('SUPABASE_URL');
      const PROFILE_API_URL = `${PROJECT_URL}/functions/v1/api/profile/feed`;
      const profileRes = await fetch(PROFILE_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': c.req.header('Authorization') || '',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ emails: Array.from(emailsToFetch) })
      });
      if (!profileRes.ok) {
        const errorText = await profileRes.text();
        console.error('Failed to fetch profiles via API:', errorText);
        throw new Error('Failed to fetch user profiles');
      }
      const enrichedUsers = await profileRes.json();
      const usersByEmail = new Map();
      enrichedUsers.forEach((u: any) => {
        if (u._internal_email_lookup) usersByEmail.set(u._internal_email_lookup, u);
      });

      // Fetch company data if this is a company post
      let postCompanyAfterCreate: { name: string; logo?: string | null } | null = null;
      if (post.company_id) {
        const { data: co } = await supabase.from('companies').select('id, name, logo').eq('id', post.company_id).maybeSingle();
        postCompanyAfterCreate = co;
      }

      // Fetch linked article data if present
      let linkedArticleAfterCreate: any = null;
      if (post.linked_article_id) {
        const { data: la } = await supabase
          .from('articles')
          .select('id, title, cover_image_url, excerpt, read_time')
          .eq('id', post.linked_article_id)
          .maybeSingle();
        linkedArticleAfterCreate = la ?? null;
      }

      const commentsEnriched = comments.map((comment: any) => {
        const senderEmail = comment.sender;
        const profileData = usersByEmail.get(senderEmail?.toLowerCase());
        let author;
        if (profileData) {
          const isAnonymous = profileData.is_anonymous === true;
          const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData;
          author = {
            ...cleanProfile,
            first_name: cleanProfile.first_name,
            last_name: cleanProfile.last_name,
            is_anonymous: isAnonymous
          };
        } else {
          author = {
            first_name: senderEmail,
            last_name: null,
            image: null,
            is_anonymous: false
          };
        }
        const currentCommentLikes = (commentLikes || []).filter(
          (l: any) => l.target_id === comment.id.toString()
        );
        const reactionCounts = currentCommentLikes.reduce((acc: any, like: any) => {
          const type = like.reaction_type || 'like';
          acc[type] = (acc[type] || 0) + 1;
          return acc;
        }, {});
        const userReactions = currentCommentLikes
          .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
          .map((l: any) => l.reaction_type);
        const seenUsers = new Set<string>();
        const reactionUsers = currentCommentLikes
          .filter((l: any) => {
            const userId = l?.user_id;
            if (userId === null || userId === undefined) return false;
            const normalizedUserId = String(userId);
            if (seenUsers.has(normalizedUserId)) return false;
            seenUsers.add(normalizedUserId);
            return true;
          })
          .map((l: any) => ({
            user_id: String(l.user_id),
            reaction_type: l.reaction_type || 'like'
          }));
        const { sender, ...commentWithoutSender } = comment;
        return {
          ...commentWithoutSender,
          attachments: normalizeAttachments(comment.attachments),
          author,
          likes_count: currentCommentLikes.length,
          reaction_users: reactionUsers,
          reaction_counts: reactionCounts,
          user_reactions: userReactions,
          user_reaction: userReactions[0] || null,
          is_liked: userReactions.length > 0
        };
      });

      const senderEmail = post.sender;
      const profileData = usersByEmail.get(senderEmail?.toLowerCase());
      let postAuthor;
      if (postCompanyAfterCreate) {
        postAuthor = buildCompanyAuthor(postCompanyAfterCreate);
      } else if (profileData) {
        const isAnonymous = profileData.is_anonymous === true;
        const { _internal_email_lookup, email: _authorEmail, ...cleanProfile } = profileData;
        postAuthor = {
          ...cleanProfile,
          first_name: cleanProfile.first_name,
          last_name: cleanProfile.last_name,
          is_anonymous: isAnonymous
        };
      } else {
        postAuthor = {
          first_name: senderEmail,
          last_name: null,
          image: null,
          is_anonymous: false
        };
      }
      const reactionCounts = (postLikes || []).reduce((acc: any, like: any) => {
        const type = like.reaction_type || 'like';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {});
      const userReactions = (postLikes || [])
        .filter((l: any) => l.user_id === currentUserUuid || l.user_uuid === currentUserUuid)
        .map((l: any) => l.reaction_type);
      const seenPostUsers = new Set<string>();
      const reactionUsers = (postLikes || [])
        .filter((l: any) => {
          const userId = l?.user_id;
          if (userId === null || userId === undefined) return false;
          const normalizedUserId = String(userId);
          if (seenPostUsers.has(normalizedUserId)) return false;
          seenPostUsers.add(normalizedUserId);
          return true;
        })
        .map((l: any) => ({
          user_id: String(l.user_id),
          reaction_type: l.reaction_type || 'like'
        }));
      const { sender, ...postWithoutSender } = post;
      return c.json({
        success: true,
        data: {
          ...postWithoutSender,
          ...(post.company_id ? { is_company_post: true } : {}),
          attachments: normalizeAttachments(post.attachments),
          author: postAuthor,
          comments: commentsEnriched,
          likes_count: (postLikes || []).length,
          reaction_users: reactionUsers,
          reaction_counts: reactionCounts,
          user_reactions: userReactions,
          user_reaction: userReactions[0] || null,
          is_liked: userReactions.length > 0,
          is_saved: !!savedRow,
          saved_id: savedRow?.id ?? null,
          ...(linkedArticleAfterCreate ? { linked_article: linkedArticleAfterCreate } : {}),
        },
        mode: "app"
      });
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
})


app.put('/:id', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('id')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    // 1) שליפת הפוסט הקיים — בדיקת הרשאות ו-attachments
    const supabaseAdminPut = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: existingPost, error: fetchError } = await supabaseAdminPut
      .from('posts')
      .select('attachments, sender, posted_by_uuid')
      .eq('id', postId)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return c.json({ error: "Post not found or you don't have permission to edit it" }, 404)
      }
      throw fetchError
    }

    const canEdit = existingPost.sender === user.email || existingPost.posted_by_uuid === user.id
    if (!canEdit) {
      return c.json({ error: "Post not found or you don't have permission to edit it" }, 404)
    }

    // 2) הכנת אובייקט עדכון
    const updateData: any = {
      updated_at: new Date().toISOString(),
      is_edited: true
    }

    if (body.message !== undefined) updateData.message = body.message
    if (body.subject !== undefined) updateData.subject = body.subject
    if (body.post_type !== undefined) {
      if (!VALID_POST_TYPES.has(body.post_type)) return c.json({ error: 'Invalid post_type' }, 400)
      updateData.post_type = body.post_type
    }

    const communityMembersOnlyInput = body.communityMembersOnly
    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400)
      }
      updateData.community_members_only = communityMembersOnlyInput
    }

    // 3) טיפול ב-attachments בצורה בטוחה (URL מלא ↔ path יחסי)
    let filesToDelete: string[] = []

    if (body.attachments !== undefined) {
      const normalizedNewAttachments = (normalizeAttachments(body.attachments) || [])

      // ✅ נוודא שכל localPath נשמר כ-path יחסי בלבד (extracted_attachments/...)
      const cleanedNewAttachments = normalizedNewAttachments.map((a: any) => {
        if (!a || typeof a === 'string') return a

        const p = toStoragePath(a) // מחזיר extracted_attachments/... או null
        if (p) return { ...a, localPath: p }
        return a
      })

      updateData.attachments = cleanedNewAttachments

      const oldAttachments = existingPost.attachments || []

      const newIdentifiers = cleanedNewAttachments
        .map((a: any) => toStoragePath(a))
        .filter(Boolean) as string[]

      // ✅ Fail-safe: אם אי אפשר לגזור מזהים חדשים, לא מוחקים כלום
      if (newIdentifiers.length > 0) {
        for (const oldAtt of oldAttachments) {
          const oldPath = toStoragePath(oldAtt)
          if (oldPath && !newIdentifiers.includes(oldPath)) {
            filesToDelete.push(oldPath)
          }
        }
      } else {
        console.warn("Skipping deletion: could not derive storage paths from new attachments")
      }
    }

    // 4) עדכון DB
    const { data, error } = await supabaseAdminPut
      .from('posts')
      .update(updateData)
      .eq('id', postId)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Post not found or you don't have permission to edit it" }, 404)
      }
      throw error
    }

    // 5) מחיקה פיזית של קבצים שהוסרו (רק paths יחסיים!)
    if (filesToDelete.length > 0) {
      const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
      if (storageError) console.error("Failed to delete old files from storage:", storageError)
    }

    // 6) עדכון וקטור אם טקסט השתנה
    if (body.message !== undefined || body.subject !== undefined) {
      updatePostVector(postId)
    }

    return c.json({ success: true, data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})


app.delete('/:id', async (c) => {
  try {
    const user = c.get('user');
    // נוודא שהמשתמש מחובר
    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const supabase = c.get('supabase');
    const postId = c.req.param('id');
    
    if (!postId) return c.json({ error: "Post ID is required" }, 400);

    // 1. בדיקת הרשאות ומחיקה
    const supabaseAdminDel = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: postToDelete, error: fetchDelError } = await supabaseAdminDel
      .from('posts')
      .select('sender, posted_by_uuid, attachments')
      .eq('id', postId)
      .single();

    if (fetchDelError) {
      if (fetchDelError.code === 'PGRST116') {
        return c.json({ error: "Post not found or you don't have permission to delete it" }, 404);
      }
      throw fetchDelError;
    }

    const canDelete = postToDelete.sender === user.email || postToDelete.posted_by_uuid === user.id
    if (!canDelete) {
      return c.json({ error: "Post not found or you don't have permission to delete it" }, 404);
    }

    const { data: deletedPost, error } = await supabaseAdminDel
      .from('posts')
      .delete()
      .eq('id', postId)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
         return c.json({ error: "Post not found or you don't have permission to delete it" }, 404);
      }
      throw error;
    }

    // 2. מחיקת כל הקבצים של הפוסט מהבאקט
    if (deletedPost && deletedPost.attachments && deletedPost.attachments.length > 0) {
      const filesToDelete = deletedPost.attachments
        .map((a: any) => {
          if (typeof a === 'string') return null;
          
          // הכי בטוח ומהיר - להשתמש ב-localPath
          if (a.localPath) return a.localPath;
          
          // גיבוי למקרה שאין localPath אבל יש URL
          if (a.url) {
            const parts = a.url.split('/attachments/');
            return parts.length > 1 ? parts[1] : null;
          }
          
          return null;
        })
        .filter(Boolean); // מסנן ערכים ריקים

      if (filesToDelete.length > 0) {
        const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete);
        if (storageError) console.error("Failed to delete files on post deletion:", storageError);
      }
    }

    return c.json({ success: true, message: "Post and files deleted successfully" });

  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
})

app.post('/comments', async (c) => {
  try {
    const supabase = c.get('supabase')
    const user = c.get('user')
    const postId = c.req.query('id')
    const { message, attachments, community_members_only, communityMembersOnly, parent_comment_id } = await c.req.json()
    const communityMembersOnlyInput =
    communityMembersOnly !== undefined ? communityMembersOnly : community_members_only

    if (!user) return c.json({ error: "Unauthorized" }, 401)
    if (!postId) return c.json({ error: "Post ID query param is required" }, 400)
    if (!message) return c.json({ error: "Message is required" }, 400)
    if (plainTextLength(message) > 1000) return c.json({ error: "Message too long" }, 400)
    if (communityMembersOnlyInput !== undefined && typeof communityMembersOnlyInput !== 'boolean') {
      return c.json({ error: "community_members_only must be boolean" }, 400)
    }

    let resolvedCommunityMembersOnly = communityMembersOnlyInput === true
    let parentCommentAuthorId: string | null = null

    // אם זו תגובה לתגובה — מאמתים ויורשים community_members_only מהתגובה הראשית
    if (parent_comment_id) {
      const { data: parentComment, error: parentError } = await supabase
        .from('comments')
        .select('id, parent_comment_id, community_members_only, sender')
        .eq('id', parent_comment_id)
        .single()

      if (parentError || !parentComment) return c.json({ error: "Parent comment not found" }, 404)
      if (parentComment.parent_comment_id) return c.json({ error: "Cannot reply to a reply" }, 400)

      resolvedCommunityMembersOnly = parentComment.community_members_only === true

      // שליפת ה-uuid של כותב התגובה הראשית לצורך נוטיפיקציה
      const { data: parentAuthorData } = await supabase
        .from('public_users_view')
        .select('uuid')
        .eq('email', parentComment.sender)
        .single()
      if (parentAuthorData?.uuid) parentCommentAuthorId = parentAuthorData.uuid
    }

    const normalizedAttachments = normalizeAttachments(attachments)

    // 1. הכנסת התגובה לטבלת comments
    const { data: commentData, error: commentError } = await supabase
      .from('comments')
      .insert({
        post_id: postId,
        sender: user.email,
        message: message,
        attachments: normalizedAttachments,
        community_members_only: resolvedCommunityMembersOnly,
        parent_comment_id: parent_comment_id || null,
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    if (commentError) throw commentError

    await insertMentionNotifications(supabase, message, user.id, postId,
      parentCommentAuthorId ? [parentCommentAuthorId] : [])

    if (parentCommentAuthorId) {
      await insertReplyNotification(supabase, user.id, parentCommentAuthorId, postId)
    }

    // 2. שליפת ה-uuid וה-first_name, last_name מטבלת public_users_view לפי המייל
    const { data: userData, error: userError } = await supabase
      .from('public_users_view')
      .select('uuid, first_name, last_name')
      .eq('email', user.email)
      .single()

    if (userError) throw userError

    // עדכון וקטור רק לתגובות ראשיות (לא לתגובות על תגובות)
    if (!parent_comment_id && isQualityPost(message)) {
      updatePostVector(postId)
    }

    // 3. החזרת האובייקט המבוקש עם id ושם
    return c.json({
      success: true,
      data: {
        ...commentData,
        author: {
          id: userData.uuid,
          first_name: userData.first_name,
          last_name: userData.last_name
        }
      }
    })

  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// // עדכון תגובה
// // עדכון תגובה (כולל טיפול במחיקת קבצים שהוסרו בעריכה)
app.put('/:postId/comments/:commentId', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('postId')
    const commentId = c.req.param('commentId')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)
    if (!commentId) return c.json({ error: "Comment ID is required" }, 400)

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Invalid JSON" }, 400)
    }

    // 1) שליפת התגובה הקיימת כדי להשוות attachments
    const { data: existingComment, error: fetchError } = await supabase
      .from('comments')
      .select('attachments')
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to edit it" }, 404)
      }
      throw fetchError
    }

    // 2) נכין את האובייקט לעדכון
    const updateData: any = {
      updated_at: new Date().toISOString(),
      is_edited: true
    }

    if (body.message !== undefined) updateData.message = body.message

    const communityMembersOnlyInput =
      body.communityMembersOnly !== undefined ? body.communityMembersOnly : body.community_members_only

    if (communityMembersOnlyInput !== undefined) {
      if (typeof communityMembersOnlyInput !== 'boolean') {
        return c.json({ error: "community_members_only must be boolean" }, 400)
      }
      updateData.community_members_only = communityMembersOnlyInput
    }

    // 3) טיפול ב-attachments בצורה בטוחה (URL מלא ↔ path יחסי)
    let filesToDelete: string[] = []

    if (body.attachments !== undefined) {
      const normalizedNewAttachments = (normalizeAttachments(body.attachments) || [])

      // ✅ נוודא שכל localPath נשמר כ-path יחסי בלבד
      const cleanedNewAttachments = normalizedNewAttachments.map((a: any) => {
        if (!a || typeof a === 'string') return a
        const p = toStoragePath(a) // extracted_attachments/... או null
        return p ? { ...a, localPath: p } : a
      })

      updateData.attachments = cleanedNewAttachments

      const oldAttachments = existingComment.attachments || []

      // ✅ מזהים חדשים להשוואה: תמיד storage path
      const newIdentifiers = cleanedNewAttachments
        .map((a: any) => toStoragePath(a))
        .filter(Boolean) as string[]

      // ✅ Fail-safe: אם לא הצלחנו לגזור מזהים חדשים, לא מוחקים כלום
      if (newIdentifiers.length > 0) {
        for (const oldAtt of oldAttachments) {
          const oldPath = toStoragePath(oldAtt)
          if (oldPath && !newIdentifiers.includes(oldPath)) {
            filesToDelete.push(oldPath)
          }
        }
      } else {
        console.warn("Skipping deletion: could not derive storage paths from new attachments")
      }
    }

    // 4) ביצוע העדכון במסד הנתונים
    const { data, error } = await supabase
      .from('comments')
      .update(updateData)
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .select()
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to edit it" }, 404)
      }
      throw error
    }

    // 5) מחיקת הקבצים הפיזיים מהבאקט (רק paths יחסיים!)
    if (filesToDelete.length > 0) {
      const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
      if (storageError) console.error("Failed to delete old files from storage:", storageError)
    }

    // 6) עדכון וקטור אם הטקסט השתנה ואיכותי
    if (body.message !== undefined && isQualityPost(body.message)) {
      updatePostVector(postId)
    }

    return c.json({ success: true, data })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// מחיקת תגובה
app.delete('/:postId/comments/:commentId', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: "Unauthorized" }, 401)

    const supabase = c.get('supabase')
    const postId = c.req.param('postId')
    const commentId = c.req.param('commentId')

    if (!postId) return c.json({ error: "Post ID is required" }, 400)
    if (!commentId) return c.json({ error: "Comment ID is required" }, 400)

    // 1) מוחקים ומחזירים את השורה כדי שנוכל למחוק קבצים מהבאקט
    const { data: deletedComment, error } = await supabase
      .from('comments')
      .delete()
      .eq('id', commentId)
      .eq('post_id', postId)
      .eq('sender', user.email)
      .select('id, post_id, attachments')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return c.json({ error: "Comment not found or you don't have permission to delete it" }, 404)
      }
      throw error
    }

    // 2) מחיקת קבצים של התגובה מהבאקט (אם יש)
    if (deletedComment?.attachments?.length > 0) {
      const filesToDelete = deletedComment.attachments
        .map((a: any) => {
          if (typeof a === 'string') return null

          if (a.localPath) return a.localPath

          // גיבוי: אם אין localPath אבל יש URL
          if (a.url) {
            const parts = a.url.split('/attachments/')
            return parts.length > 1 ? parts[1] : null
          }

          return null
        })
        .filter(Boolean)

      if (filesToDelete.length > 0) {
        const { error: storageError } = await supabase.storage.from('attachments').remove(filesToDelete)
        if (storageError) console.error("Failed to delete files on comment deletion:", storageError)
      }
    }

    // 3) עדכון הווקטור של הפוסט כדי להסיר את הטקסט של התגובה שנמחקה
    //    חשוב שזה יקרה אחרי המחיקה
    updatePostVector(postId)

    return c.json({ success: true, message: "Comment deleted successfully" })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})



// ====================================================================
// Record a post impression (fire-and-forget)
// POST /posts/:id/impression
// ====================================================================
app.post('/:id/impression', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ ok: true })

    const supabase = c.get('supabase')
    const postId = String(c.req.param('id'))
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: post } = await supabaseAdmin
      .from('posts')
      .select('sender')
      .eq('id', postId)
      .maybeSingle()

    // Self-view guard
    if (post?.sender && user.email?.toLowerCase() === post.sender.toLowerCase()) {
      return c.json({ ok: true })
    }

    const today = new Date().toISOString().slice(0, 10)
    const impressionResult = await supabase
      .from('post_impressions')
      .upsert(
        {
          post_id: postId,
          user_id: user.id,
          impression_date: today,
          last_seen_at: new Date().toISOString()
        },
        { onConflict: 'post_id,user_id,impression_date', ignoreDuplicates: false }
      )
    if (impressionResult.error) {
      console.error('[impression] upsert error:', impressionResult.error.message)
    }

    return c.json({ ok: true })
  } catch {
    return c.json({ ok: true })
  }
})

// ====================================================================
// FEED SESSION TIME
// POST /posts/feed-session — זמן שהייה בפיד (שניות)
// ====================================================================
app.post('/feed-session', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ ok: true })
    const body = await c.req.json().catch(() => ({}))
    const seconds = Math.min(Math.max(0, Number(body.seconds) || 0), 7200) // cap 2h
    if (seconds < 5) return c.json({ ok: true })
    const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await supabaseAdmin.rpc('add_feed_time', { p_user_id: user.id, p_seconds: seconds })
  } catch { /* fire-and-forget */ }
  return c.json({ ok: true })
})

// ====================================================================
// REPORT POST
// ====================================================================

app.post('/:id/report', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const postId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const reason = (body.reason || '').trim()

  if (!reason) return c.json({ error: 'reason is required' }, 400)

  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const { error } = await supabaseAdmin.from('post_reports').insert({
    post_id: postId,
    reporter_id: user.id,
    reason,
  })

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ success: true })
})

// ====================================================================
// ADMIN: BACKFILL VECTORS FOR HTML POSTS
// ====================================================================

export default app