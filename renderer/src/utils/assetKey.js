export function assetKey(asset) {
  if (!asset) return ''
  return `${asset.source ?? ''}:${asset.apiSymbol ?? asset.symbol ?? ''}`
}

export function underlyingSymbol(asset) {
  const symbol = String(asset?.symbol ?? asset?.apiSymbol ?? '').toUpperCase()
  if (asset?.type === 'tradfi' && symbol.endsWith('USDT')) return symbol.slice(0, -4)
  return symbol
}

export function underlyingKey(asset) {
  const symbol = underlyingSymbol(asset)
  if (!symbol) return ''
  if (asset?.type === 'stock' || asset?.type === 'tradfi') return `equity:${symbol}`
  return `${asset?.type ?? 'asset'}:${symbol}`
}

export function sameUnderlying(left, right) {
  const key = underlyingKey(left)
  return !!key && key === underlyingKey(right)
}

export function venueLabel(asset) {
  if (asset?.type === 'stock' || asset?.source === 'yahoo') return '美股现货'
  if (asset?.type === 'tradfi') return 'TradFi 合约'
  if (asset?.source === 'binance-futures') return '币安合约'
  return '现货'
}

export function matchesAssetRef(asset, ref) {
  return assetKey(asset) === ref || asset?.symbol === ref || asset?.apiSymbol === ref
}
