import { Hono } from 'https://deno.land/x/hono/mod.ts'

const app = new Hono()

// CBS (Israel Central Bureau of Statistics) Job Vacancy Survey — public API, no key required.
// Path segments: survey > number/rate of vacancies > by economic sector > vacancies metric > sector name_id
const CBS_SERIES_BASE = 'https://apis.cbs.gov.il/series/data/path'
const CBS_PATHS = {
  hightechServicesVacancies: '35,1,1,1,7452',
  hightechIndustryVacancies: '35,1,1,1,7453',
  hightechServicesRate: '35,1,1,2,7452',
  totalEconomyVacancies: '35,1,1,1,365',
} as const

interface HighTechMarketStats {
  vacanciesTotal: number
  vacancyRatePercent: number
  shareOfEconomyPercent: number
  period: string
  sourceUrl: string
}

interface CbsObservation {
  value: number
  period: string
}

async function fetchCbsSeasonallyAdjusted(path: string): Promise<CbsObservation> {
  const res = await fetch(`${CBS_SERIES_BASE}?id=${path}&format=json&last=3`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`CBS non-2xx for ${path}`)

  const json = await res.json()
  const series = json?.DataSet?.Series ?? []
  // data.value === 2 is CBS's "seasonally adjusted" variant — their standard headline figure
  const seasonal = series.find((s: any) => s?.data?.value === 2)
  const obs = seasonal?.obs?.[0]
  if (!obs || typeof obs.Value !== 'number') throw new Error(`No observation for ${path}`)

  return { value: obs.Value, period: obs.TimePeriod }
}

async function fetchFromCbs(): Promise<HighTechMarketStats> {
  const [services, industry, rate, totalEconomy] = await Promise.all([
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechServicesVacancies),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechIndustryVacancies),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechServicesRate),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.totalEconomyVacancies),
  ])

  const vacanciesTotal = services.value + industry.value

  return {
    vacanciesTotal,
    vacancyRatePercent: rate.value,
    shareOfEconomyPercent: (vacanciesTotal / totalEconomy.value) * 100,
    period: services.period,
    sourceUrl: 'https://www.cbs.gov.il/he/subjects/Pages/הייטק.aspx',
  }
}

let cache: { data: HighTechMarketStats; fetchedAt: number } | null = null
const TTL_MS = 24 * 60 * 60 * 1000

// GET /market-stats/hightech
// Thin TTL cache in front of CBS — at most one outbound call/day regardless of traffic.
// Serves the last known-good value on CBS failure rather than breaking the Jobs page.
app.get('/hightech', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'Unauthorized' }, 401)

  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return c.json(cache.data)
  }

  try {
    const fresh = await fetchFromCbs()
    cache = { data: fresh, fetchedAt: Date.now() }
    return c.json(fresh)
  } catch {
    if (cache) return c.json(cache.data)
    return c.json({ error: 'unavailable' }, 503)
  }
})

export default app
