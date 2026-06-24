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
  vacanciesServices: number
  vacanciesIndustry: number
  vacanciesTotal: number
  vacanciesTotalChangePercent: number | null
  vacancyRatePercent: number
  vacancyRateChangePoints: number | null
  shareOfEconomyPercent: number
  shareOfEconomyChangePoints: number | null
  period: string
  sourceUrl: string
}

interface CbsObservation {
  value: number
  previousValue: number | null
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

  // obs[1], if present, is the prior month — used for month-over-month trend
  const prevObs = seasonal?.obs?.[1]
  const previousValue = typeof prevObs?.Value === 'number' ? prevObs.Value : null

  return { value: obs.Value, previousValue, period: obs.TimePeriod }
}

function percentChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function pointChange(current: number, previous: number | null): number | null {
  if (previous === null) return null
  return current - previous
}

async function fetchFromCbs(): Promise<HighTechMarketStats> {
  const [services, industry, rate, totalEconomy] = await Promise.all([
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechServicesVacancies),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechIndustryVacancies),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.hightechServicesRate),
    fetchCbsSeasonallyAdjusted(CBS_PATHS.totalEconomyVacancies),
  ])

  const vacanciesTotal = services.value + industry.value
  const vacanciesTotalPrev =
    services.previousValue !== null && industry.previousValue !== null
      ? services.previousValue + industry.previousValue
      : null

  const shareOfEconomyPercent = (vacanciesTotal / totalEconomy.value) * 100
  const shareOfEconomyPrev =
    vacanciesTotalPrev !== null && totalEconomy.previousValue !== null
      ? (vacanciesTotalPrev / totalEconomy.previousValue) * 100
      : null

  return {
    vacanciesServices: services.value,
    vacanciesIndustry: industry.value,
    vacanciesTotal,
    vacanciesTotalChangePercent: percentChange(vacanciesTotal, vacanciesTotalPrev),
    vacancyRatePercent: rate.value,
    vacancyRateChangePoints: pointChange(rate.value, rate.previousValue),
    shareOfEconomyPercent,
    shareOfEconomyChangePoints: pointChange(shareOfEconomyPercent, shareOfEconomyPrev),
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
