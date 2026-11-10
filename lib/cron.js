/**
 * Minimal five-field cron evaluator (minute hour day-of-month month day-of-week).
 *
 * Supports `*`, numbers, ranges (`1-5`), lists (`1,3,5`) and steps (`*​/6`,
 * `0-30/10`), with Sunday as both 0 and 7. It exists so a scheduled backup can
 * use a cron expression without pulling a dependency into the Host plugin.
 */

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
]

/** Parse one field into a sorted set of allowed numbers. */
function parseField(text, { min, max }, index) {
  const value = String(text).trim()
  if (value === '') throw new Error(`cron: field ${index + 1} is empty`)
  const allowed = new Set()
  for (const part of value.split(',')) {
    const [rangeText, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: invalid step "${part}"`)
    let start
    let end
    if (rangeText === '*') {
      start = min
      // Day-of-week treats `*` as 0-6 (Sunday..Saturday) even though 7 is accepted.
      end = index === 4 ? 6 : max
    } else if (rangeText.includes('-')) {
      const [from, to] = rangeText.split('-')
      start = Number(from)
      end = Number(to)
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) throw new Error(`cron: invalid range "${part}"`)
    } else {
      start = Number(rangeText)
      end = start
      if (!Number.isInteger(start)) throw new Error(`cron: invalid value "${part}"`)
    }
    if (start < min || end > max) throw new Error(`cron: value out of range in "${part}" (${min}-${max})`)
    for (let current = start; current <= end; current += step) allowed.add(current)
  }
  // Day-of-week accepts 7 as Sunday.
  if (index === 4 && allowed.has(7)) allowed.add(0)
  return allowed
}

/** Parse an expression into per-field sets; throws on malformed input. */
export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron: expected five fields (minute hour day month weekday)')
  return fields.map((field, index) => parseField(field, FIELDS[index], index))
}

/**
 * Next matching local time strictly after `from`.
 *
 * Day-of-month and day-of-week follow cron's OR rule when both are restricted:
 * a day matches when either field matches.
 */
export function nextCronTime(expression, from = Date.now()) {
  const [minutes, hours, days, months, weekdays] = parseCron(expression)
  const dayRestricted = days.size !== 31
  const weekdayRestricted = weekdays.size !== 7
  const start = new Date(from)
  start.setSeconds(0, 0)
  const cursor = new Date(start.getTime() + 60 * 1000)
  const limit = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000)
  while (cursor <= limit) {
    if (!months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    const weekday = cursor.getDay()
    const day = cursor.getDate()
    const dayMatches = dayRestricted || weekdayRestricted
      ? (dayRestricted && days.has(day)) || (weekdayRestricted && weekdays.has(weekday))
      : true
    if (!dayMatches) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    return cursor.getTime()
  }
  return undefined
}

/** Human-readable validation used by the settings endpoint. */
export function assertCron(expression) {
  parseCron(expression)
  const next = nextCronTime(expression, Date.now())
  if (next === undefined) throw new Error('cron: expression never fires within a year')
  return next
}
