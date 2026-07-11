export const COMPANY_EVENTS_CACHE_KEY = 'rsi:companyEvents:cache'

export function eventGuard(event, now = Date.now()) {
  const at = Number(event?.effectiveAt ?? event?.announcedAt)
  if (!Number.isFinite(at)) return { active: false, blocking: false }
  const type = event.eventType
  const before = type === 'earnings' ? 24 * 60 * 60 * 1000 : 0
  const after = type === 'split' ? 2 * 24 * 60 * 60 * 1000
    : type === 'earnings' ? 24 * 60 * 60 * 1000
      : type === 'halt' || type === 'bankruptcy' || type === 'merger' ? 7 * 24 * 60 * 60 * 1000
        : 12 * 60 * 60 * 1000
  const active = now >= at - before && now <= at + after
  return { active, blocking: active && ['split', 'halt', 'bankruptcy', 'merger'].includes(type) }
}

export function eventsForAsset(events, asset, now = Date.now()) {
  const key = `equity:${String(asset?.symbol ?? '').toUpperCase()}`
  return (events ?? []).filter(event => event.underlyingKey === key).map(event => ({ ...event, guard: eventGuard(event, now) }))
}
