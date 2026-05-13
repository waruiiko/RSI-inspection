export function assetKey(asset) {
  if (!asset) return ''
  return `${asset.source ?? ''}:${asset.apiSymbol ?? asset.symbol ?? ''}`
}

export function matchesAssetRef(asset, ref) {
  return assetKey(asset) === ref || asset?.symbol === ref || asset?.apiSymbol === ref
}
