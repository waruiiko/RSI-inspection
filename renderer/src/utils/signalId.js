function finite(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizePrice(value) {
  const n = finite(value)
  return n == null ? '' : n.toPrecision(8)
}

function sideCode(side) {
  return side === 'short' ? 'S' : 'L'
}

function hashText(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4)
}

export function signalIdFromParts({ symbol, side, timeframe, entryPrice, stopLoss }) {
  const sym = String(symbol ?? 'UNK').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'UNK'
  const tf = String(timeframe ?? 'NA').toUpperCase()
  const sidePart = sideCode(side)
  const seed = [
    sym,
    sidePart,
    tf,
    normalizePrice(entryPrice),
    normalizePrice(stopLoss),
  ].join('|')
  return `SH-${sym}-${tf}-${sidePart}-${hashText(seed)}`
}

export function signalIdFromAsset(asset) {
  const sig = asset?.signalHunter ?? {}
  return signalIdFromParts({
    symbol: asset?.symbol,
    side: sig.side,
    timeframe: sig.timeframe,
    entryPrice: sig.entryPrice ?? sig.triggerPrice,
    stopLoss: sig.stopLoss,
  })
}

export function signalIdFromReviewItem(item) {
  return signalIdFromParts({
    symbol: item?.symbol,
    side: item?.side,
    timeframe: item?.timeframe,
    entryPrice: item?.entryPrice,
    stopLoss: item?.stopLoss,
  })
}
