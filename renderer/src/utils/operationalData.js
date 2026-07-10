export async function hydrateOperationalData(key, fallback) {
  if (!window.api?.loadOperationalData) return fallback
  try {
    const stored = await window.api.loadOperationalData(key)
    if (stored != null) return stored
    await window.api.saveOperationalData(key, fallback)
  } catch (err) {
    console.warn(`[operational:${key}] hydrate failed`, err)
  }
  return fallback
}

export function persistOperationalData(key, value) {
  window.api?.saveOperationalData?.(key, value).catch(err => {
    console.warn(`[operational:${key}] save failed`, err)
  })
}
