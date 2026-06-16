import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

const extractMeta = (html: string, property: string): string | null => {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return m[1].trim()
  }
  return null
}

const extractTitle = (html: string): string | null => {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m?.[1]?.trim() ?? null
}

const BOT_CHALLENGE_PATTERNS = [
  'attention required',
  'just a moment',
  'please wait',
  'access denied',
  'ddos protection',
  'checking your browser',
  'enable javascript and cookies',
  'one more step',
  'security check',
  'verifying you are human',
]

function isBotChallengePage(html: string, title: string | null): boolean {
  if (!title) return false
  const lower = title.toLowerCase()
  if (BOT_CHALLENGE_PATTERNS.some(p => lower.includes(p))) return true
  // Cloudflare challenge pages always have both cf-ray meta and no real og:title
  if (html.includes('cf-wrapper') || html.includes('cf_chl_')) return true
  return false
}

// GET /api/link-preview?url=https://...
app.get('/', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  const url = c.req.query('url')
  if (!url || !/^https?:\/\/.+/.test(url)) {
    return c.json({ error: 'Invalid url' }, 400)
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(6000),
    })

    if (!res.ok) throw new Error('non-2xx')

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) throw new Error('not-html')

    // Read only the first 50 KB — enough for <head>
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no-reader')

    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      totalBytes += value.length
      if (totalBytes >= 50_000) break
    }
    reader.cancel()

    const html = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length)
        merged.set(acc)
        merged.set(chunk, acc.length)
        return merged
      }, new Uint8Array())
    )

    const title = extractMeta(html, 'og:title') ?? extractTitle(html)

    if (!isBotChallengePage(html, title)) {
      const ogImage = extractMeta(html, 'og:image')
      let image = ogImage
      if (image && !image.startsWith('http')) {
        try {
          const base = new URL(url)
          image = new URL(image, base.origin).href
        } catch {
          image = null
        }
      }

      return c.json({
        url,
        title,
        description: extractMeta(html, 'og:description') ?? extractMeta(html, 'description'),
        image,
        siteName: extractMeta(html, 'og:site_name') ?? new URL(url).hostname.replace('www.', ''),
      })
    }

    // Our scraper was blocked — fall through to Microlink
  } catch {
    // Network error or timeout — fall through to Microlink
  }

  // Fallback: Microlink (handles Cloudflare-protected sites via real browser rendering)
  try {
    const ml = await fetch(
      `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=false`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (ml.ok) {
      const { status, data } = await ml.json() as {
        status: string
        data: {
          title?: string | null
          description?: string | null
          image?: { url?: string | null } | null
          publisher?: string | null
        }
      }
      if (status === 'success' && data) {
        return c.json({
          url,
          title: data.title ?? null,
          description: data.description ?? null,
          image: data.image?.url ?? null,
          siteName: data.publisher ?? new URL(url).hostname.replace('www.', ''),
        })
      }
    }
  } catch {
    // Microlink also failed
  }

  return c.json({ url, title: null, description: null, image: null, siteName: null })
})

export default app
