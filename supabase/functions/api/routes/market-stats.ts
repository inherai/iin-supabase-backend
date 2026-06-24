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

const HISTORY_MONTHS = 24

interface Range {
  min: number
  max: number
}

interface HighTechMarketStats {
  vacanciesServices: number
  vacanciesIndustry: number
  vacanciesTotal: number
  vacanciesTotalChangePercent: number | null
  vacancyRatePercent: number
  vacancyRateChangePoints: number | null
  vacancyRateRange: Range
  shareOfEconomyPercent: number
  shareOfEconomyChangePoints: number | null
  shareOfEconomyRange: Range
  period: string
  sourceUrl: string
  history: { period: string; vacanciesTotal: number }[]
}

interface CbsPoint {
  period: string
  value: number
}

// Returns the seasonally-adjusted observations for a series, newest first (obs[0] = latest).
async function fetchCbsSeries(path: string, last: number): Promise<CbsPoint[]> {
  const res = await fetch(`${CBS_SERIES_BASE}?id=${path}&format=json&last=${last}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`CBS non-2xx for ${path}`)

  const json = await res.json()
  const series = json?.DataSet?.Series ?? []
  // data.value === 2 is CBS's "seasonally adjusted" variant — their standard headline figure
  const seasonal = series.find((s: any) => s?.data?.value === 2)
  const obs: any[] = seasonal?.obs ?? []
  const points = obs
    .filter((o) => typeof o?.Value === 'number')
    .map((o) => ({ period: o.TimePeriod as string, value: o.Value as number }))
  if (points.length === 0) throw new Error(`No observations for ${path}`)
  return points
}

function percentChange(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function pointChange(current: number, previous: number | null): number | null {
  if (previous === null) return null
  return current - previous
}

function rangeOf(values: number[]): Range {
  return { min: Math.min(...values), max: Math.max(...values) }
}

async function fetchFromCbs(): Promise<HighTechMarketStats> {
  const [servicesSeries, industrySeries, rateSeries, totalEconomySeries] = await Promise.all([
    fetchCbsSeries(CBS_PATHS.hightechServicesVacancies, HISTORY_MONTHS),
    fetchCbsSeries(CBS_PATHS.hightechIndustryVacancies, HISTORY_MONTHS),
    fetchCbsSeries(CBS_PATHS.hightechServicesRate, HISTORY_MONTHS),
    fetchCbsSeries(CBS_PATHS.totalEconomyVacancies, HISTORY_MONTHS),
  ])

  const services = servicesSeries[0]
  const servicesPrev = servicesSeries[1]?.value ?? null
  const industry = industrySeries[0]
  const industryPrev = industrySeries[1]?.value ?? null
  const rate = rateSeries[0]
  const totalEconomy = totalEconomySeries[0]

  const vacanciesTotal = services.value + industry.value
  const vacanciesTotalPrev =
    servicesPrev !== null && industryPrev !== null ? servicesPrev + industryPrev : null

  const shareOfEconomyPercent = (vacanciesTotal / totalEconomy.value) * 100
  const shareOfEconomyPrev =
    vacanciesTotalPrev !== null && totalEconomySeries[1]
      ? (vacanciesTotalPrev / totalEconomySeries[1].value) * 100
      : null

  // Zip services + industry by month (same survey, same cadence) for the history chart,
  // oldest-first so it plots left-to-right chronologically.
  const monthCount = Math.min(servicesSeries.length, industrySeries.length, totalEconomySeries.length)

  const history = servicesSeries
    .slice(0, monthCount)
    .map((s, i) => ({
      period: s.period,
      vacanciesTotal: s.value + industrySeries[i].value,
    }))
    .reverse()

  // Share-of-economy per month, for the 24-month range used by the dashboard range gauge
  // ("where does today's value sit between its own 24-month low and high" — not an arbitrary 0-100 scale).
  const shareOfEconomyHistory = servicesSeries
    .slice(0, monthCount)
    .map((s, i) => ((s.value + industrySeries[i].value) / totalEconomySeries[i].value) * 100)

  return {
    vacanciesServices: services.value,
    vacanciesIndustry: industry.value,
    vacanciesTotal,
    vacanciesTotalChangePercent: percentChange(vacanciesTotal, vacanciesTotalPrev),
    vacancyRatePercent: rate.value,
    vacancyRateChangePoints: pointChange(rate.value, rateSeries[1]?.value ?? null),
    vacancyRateRange: rangeOf(rateSeries.map((p) => p.value)),
    shareOfEconomyPercent,
    shareOfEconomyChangePoints: pointChange(shareOfEconomyPercent, shareOfEconomyPrev),
    shareOfEconomyRange: rangeOf(shareOfEconomyHistory),
    period: services.period,
    sourceUrl: 'https://www.cbs.gov.il/he/subjects/Pages/הייטק.aspx',
    history,
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
