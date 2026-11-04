// When non-essential email may go out (email plan: "שבת, חג ושעות").
//   * Weekdays 08:00–21:30 Israel time.
//   * Not on Shabbat or Yom Tov: from 12:00 on the day of candle lighting (Friday / erev chag)
//     until one hour after havdalah. Times are computed for Jerusalem with @hebcal/core,
//     locally — no network call and no yearly table to maintain.
// Essential email (sign-in code, an invitation someone just sent) ignores this window.
import { HebrewCalendar, Location } from 'npm:@hebcal/core@5'

const TZ = 'Asia/Jerusalem'
const DAY_START = 8 * 60          // 08:00
const DAY_END = 21 * 60 + 30      // 21:30
const HOLD_FROM_HOUR = 12         // stop at noon before Shabbat / chag
const AFTER_HAVDALAH_MS = 60 * 60 * 1000

const jerusalem = Location.lookup('Jerusalem')!

/** Minutes since midnight and the calendar date, in Israel time. */
function israelClock(d: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  )
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` }
}

/** Shabbat / Yom Tov hold periods [start, end) around `now` (Israel calendar, Jerusalem times). */
export function restPeriods(now: Date): Array<{ start: Date; end: Date }> {
  const start = new Date(now.getTime() - 3 * 86400000)
  const end = new Date(now.getTime() + 3 * 86400000)
  const events = HebrewCalendar.calendar({ start, end, location: jerusalem, candlelighting: true, il: true })
  const periods: Array<{ start: Date; end: Date }> = []
  let open: Date | null = null
  for (const ev of events) {
    const t: Date | undefined = (ev as any).eventTime
    if (!t) continue
    const desc = ev.getDesc()
    if (desc === 'Candle lighting' && !open) {
      // Hold from 12:00 Israel time on the day candles are lit.
      const { date } = israelClock(t)
      open = zonedNoon(date)
    } else if (desc === 'Havdalah' && open) {
      periods.push({ start: open, end: new Date(t.getTime() + AFTER_HAVDALAH_MS) })
      open = null
    }
  }
  return periods
}

/** 12:00 Israel time on a YYYY-MM-DD date, as a UTC instant (handles summer/winter time). */
function zonedNoon(date: string): Date {
  for (const offset of [2, 3]) {
    const candidate = new Date(`${date}T${String(HOLD_FROM_HOUR - offset).padStart(2, '0')}:00:00Z`)
    if (israelClock(candidate).minutes === HOLD_FROM_HOUR * 60) return candidate
  }
  return new Date(`${date}T10:00:00Z`)
}

/** May a non-essential email be sent at `now`? */
export function isSendWindowOpen(now = new Date()): boolean {
  const { minutes } = israelClock(now)
  if (minutes < DAY_START || minutes >= DAY_END) return false
  return !restPeriods(now).some((p) => now >= p.start && now < p.end)
}
