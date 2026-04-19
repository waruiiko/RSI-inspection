// Pluggable indicator registry.
// To add a new indicator: create src/indicators/macd.js and call register() below.
const registry = new Map()

function register(indicator) {
  registry.set(indicator.name, indicator)
}

function compute(candles, name, params = {}) {
  const ind = registry.get(name)
  if (!ind) throw new Error(`Unknown indicator: ${name}`)
  return ind.compute(candles, { ...ind.defaultParams, ...params })
}

function computeAll(candles, names = ['rsi'], params = {}) {
  const result = {}
  for (const name of names) {
    try {
      result[name] = compute(candles, name, params[name] ?? {})
    } catch (err) {
      console.warn(`[indicators] ${name}: ${err.message}`)
      result[name] = null
    }
  }
  return result
}

// Built-in indicators
register(require('./rsi'))

module.exports = { register, compute, computeAll }
