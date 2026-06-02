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
        'User-Agent': 'Mozilla/5.0 (compatible; IINBot/1.0)',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(6000),
    })

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) {
      return c.json({ url, title: null, description: null, image: null, siteName: null })
    }

    // Read only the first 50 KB — enough for <head>
    const reader = res.body?.getReader()
    if (!reader) return c.json({ url, title: null, description: null, image: null, siteName: null })

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
      title: extractMeta(html, 'og:title') ?? extractTitle(html),
      description: extractMeta(html, 'og:description') ?? extractMeta(html, 'description'),
      image,
      siteName: extractMeta(html, 'og:site_name') ?? new URL(url).hostname.replace('www.', ''),
    })
  } catch {
    return c.json({ url, title: null, description: null, image: null, siteName: null })
  }
})

export default app
