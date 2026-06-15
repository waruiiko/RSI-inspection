export const STOCK_UNIVERSES = {
  mega: {
    label: 'Mega Cap',
    items: [
      ['AAPL', 'Apple'],
      ['MSFT', 'Microsoft'],
      ['NVDA', 'NVIDIA'],
      ['AMZN', 'Amazon'],
      ['META', 'Meta Platforms'],
      ['GOOGL', 'Alphabet Class A'],
      ['GOOG', 'Alphabet Class C'],
      ['TSLA', 'Tesla'],
      ['AVGO', 'Broadcom'],
      ['BRK-B', 'Berkshire Hathaway'],
      ['LLY', 'Eli Lilly'],
      ['JPM', 'JPMorgan Chase'],
      ['V', 'Visa'],
      ['MA', 'Mastercard'],
      ['UNH', 'UnitedHealth'],
      ['COST', 'Costco'],
      ['WMT', 'Walmart'],
      ['NFLX', 'Netflix'],
      ['ORCL', 'Oracle'],
      ['AMD', 'Advanced Micro Devices'],
    ],
  },
  aiSemi: {
    label: 'AI / Semi',
    items: [
      ['NVDA', 'NVIDIA'],
      ['AMD', 'Advanced Micro Devices'],
      ['AVGO', 'Broadcom'],
      ['TSM', 'Taiwan Semiconductor'],
      ['ASML', 'ASML Holding'],
      ['ARM', 'Arm Holdings'],
      ['MU', 'Micron Technology'],
      ['MRVL', 'Marvell Technology'],
      ['SMCI', 'Super Micro Computer'],
      ['INTC', 'Intel'],
      ['QCOM', 'Qualcomm'],
      ['AMAT', 'Applied Materials'],
      ['LRCX', 'Lam Research'],
      ['KLAC', 'KLA'],
      ['TER', 'Teradyne'],
      ['DELL', 'Dell Technologies'],
      ['HPE', 'Hewlett Packard Enterprise'],
      ['ANET', 'Arista Networks'],
      ['PLTR', 'Palantir'],
      ['SNOW', 'Snowflake'],
    ],
  },
  highBeta: {
    label: 'High Beta',
    items: [
      ['TSLA', 'Tesla'],
      ['PLTR', 'Palantir'],
      ['COIN', 'Coinbase'],
      ['HOOD', 'Robinhood'],
      ['MSTR', 'MicroStrategy'],
      ['CRCL', 'Circle Internet Group'],
      ['RBLX', 'Roblox'],
      ['SOFI', 'SoFi Technologies'],
      ['RIVN', 'Rivian'],
      ['LCID', 'Lucid Group'],
      ['MARA', 'MARA Holdings'],
      ['RIOT', 'Riot Platforms'],
      ['IREN', 'IREN'],
      ['WULF', 'TeraWulf'],
      ['UPST', 'Upstart'],
      ['DKNG', 'DraftKings'],
      ['AFRM', 'Affirm'],
      ['SHOP', 'Shopify'],
      ['ROKU', 'Roku'],
      ['NET', 'Cloudflare'],
    ],
  },
  etf: {
    label: 'ETF Core',
    items: [
      ['SPY', 'SPDR S&P 500 ETF'],
      ['QQQ', 'Invesco QQQ'],
      ['IWM', 'iShares Russell 2000 ETF'],
      ['DIA', 'SPDR Dow Jones Industrial Average ETF'],
      ['VOO', 'Vanguard S&P 500 ETF'],
      ['VTI', 'Vanguard Total Stock Market ETF'],
      ['SMH', 'VanEck Semiconductor ETF'],
      ['XLK', 'Technology Select Sector SPDR'],
      ['XLF', 'Financial Select Sector SPDR'],
      ['XLE', 'Energy Select Sector SPDR'],
      ['XLI', 'Industrial Select Sector SPDR'],
      ['XLV', 'Health Care Select Sector SPDR'],
      ['XLY', 'Consumer Discretionary Select Sector SPDR'],
      ['XLP', 'Consumer Staples Select Sector SPDR'],
      ['TLT', 'iShares 20+ Year Treasury Bond ETF'],
      ['GLD', 'SPDR Gold Shares'],
      ['SLV', 'iShares Silver Trust'],
      ['USO', 'United States Oil Fund'],
      ['TQQQ', 'ProShares UltraPro QQQ'],
      ['SQQQ', 'ProShares UltraPro Short QQQ'],
    ],
  },
}

export const CORE_CRYPTO_SYMBOLS = new Set([
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
  'ADA',
  'LINK',
  'AVAX',
  'TON',
  'TRX',
  'LTC',
  'BCH',
  'DOT',
  'NEAR',
])

export function stockUniverseEntries(keys = Object.keys(STOCK_UNIVERSES)) {
  const seen = new Set()
  const out = []
  for (const key of keys) {
    for (const [symbol, name] of STOCK_UNIVERSES[key]?.items ?? []) {
      if (seen.has(symbol)) continue
      seen.add(symbol)
      out.push({ symbol, apiSymbol: symbol, type: 'stock', source: 'yahoo', name })
    }
  }
  return out
}
