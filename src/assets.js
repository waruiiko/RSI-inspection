// 资产配置 — 在这里添加/删除要追踪的品种

const CRYPTO = [
  { symbol: 'BTC',    apiSymbol: 'BTCUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'ETH',    apiSymbol: 'ETHUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'BNB',    apiSymbol: 'BNBUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'SOL',    apiSymbol: 'SOLUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'XRP',    apiSymbol: 'XRPUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'DOGE',   apiSymbol: 'DOGEUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'ADA',    apiSymbol: 'ADAUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'AVAX',   apiSymbol: 'AVAXUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'LINK',   apiSymbol: 'LINKUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'DOT',    apiSymbol: 'DOTUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'MATIC',  apiSymbol: 'MATICUSDT',  type: 'crypto', source: 'binance' },
  { symbol: 'UNI',    apiSymbol: 'UNIUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'ATOM',   apiSymbol: 'ATOMUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'LTC',    apiSymbol: 'LTCUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'NEAR',   apiSymbol: 'NEARUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'APT',    apiSymbol: 'APTUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'ARB',    apiSymbol: 'ARBUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'OP',     apiSymbol: 'OPUSDT',     type: 'crypto', source: 'binance' },
  { symbol: 'INJ',    apiSymbol: 'INJUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'SUI',    apiSymbol: 'SUIUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'SEI',    apiSymbol: 'SEIUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'TIA',    apiSymbol: 'TIAUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'FET',    apiSymbol: 'FETUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'WIF',    apiSymbol: 'WIFUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'PENDLE', apiSymbol: 'PENDLEUSDT', type: 'crypto', source: 'binance' },
  { symbol: 'ENA',    apiSymbol: 'ENAUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'JUP',    apiSymbol: 'JUPUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'WLD',    apiSymbol: 'WLDUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'AAVE',   apiSymbol: 'AAVEUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'MKR',    apiSymbol: 'MKRUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'RUNE',   apiSymbol: 'RUNEUSDT',   type: 'crypto', source: 'binance' },
  { symbol: 'LDO',    apiSymbol: 'LDOUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'STX',    apiSymbol: 'STXUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'TRX',    apiSymbol: 'TRXUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'FIL',    apiSymbol: 'FILUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'RENDER', apiSymbol: 'RENDERUSDT', type: 'crypto', source: 'binance' },
  { symbol: 'TAO',    apiSymbol: 'TAOUSDT',    type: 'crypto', source: 'binance' },
  { symbol: 'STRK',   apiSymbol: 'STRKUSDT',   type: 'crypto', source: 'binance' },
]

const STOCKS = [
  // Mega-cap tech
  { symbol: 'AAPL',  apiSymbol: 'AAPL',  type: 'stock', source: 'yahoo' },
  { symbol: 'MSFT',  apiSymbol: 'MSFT',  type: 'stock', source: 'yahoo' },
  { symbol: 'GOOGL', apiSymbol: 'GOOGL', type: 'stock', source: 'yahoo' },
  { symbol: 'AMZN',  apiSymbol: 'AMZN',  type: 'stock', source: 'yahoo' },
  { symbol: 'META',  apiSymbol: 'META',  type: 'stock', source: 'yahoo' },
  { symbol: 'TSLA',  apiSymbol: 'TSLA',  type: 'stock', source: 'yahoo' },
  { symbol: 'NFLX',  apiSymbol: 'NFLX',  type: 'stock', source: 'yahoo' },
  // Semiconductors
  { symbol: 'NVDA',  apiSymbol: 'NVDA',  type: 'stock', source: 'yahoo' },
  { symbol: 'AMD',   apiSymbol: 'AMD',   type: 'stock', source: 'yahoo' },
  { symbol: 'INTC',  apiSymbol: 'INTC',  type: 'stock', source: 'yahoo' },
  { symbol: 'QCOM',  apiSymbol: 'QCOM',  type: 'stock', source: 'yahoo' },
  { symbol: 'AVGO',  apiSymbol: 'AVGO',  type: 'stock', source: 'yahoo' },
  // Enterprise software / cloud
  { symbol: 'CRM',   apiSymbol: 'CRM',   type: 'stock', source: 'yahoo' },
  { symbol: 'ORCL',  apiSymbol: 'ORCL',  type: 'stock', source: 'yahoo' },
  { symbol: 'ADBE',  apiSymbol: 'ADBE',  type: 'stock', source: 'yahoo' },
  { symbol: 'NOW',   apiSymbol: 'NOW',   type: 'stock', source: 'yahoo' },
  { symbol: 'SNOW',  apiSymbol: 'SNOW',  type: 'stock', source: 'yahoo' },
  // Finance
  { symbol: 'JPM',   apiSymbol: 'JPM',   type: 'stock', source: 'yahoo' },
  { symbol: 'GS',    apiSymbol: 'GS',    type: 'stock', source: 'yahoo' },
  { symbol: 'V',     apiSymbol: 'V',     type: 'stock', source: 'yahoo' },
  { symbol: 'MA',    apiSymbol: 'MA',    type: 'stock', source: 'yahoo' },
  { symbol: 'BRK-B', apiSymbol: 'BRK-B', type: 'stock', source: 'yahoo' },
  // New-age tech
  { symbol: 'COIN',  apiSymbol: 'COIN',  type: 'stock', source: 'yahoo' },
  { symbol: 'PLTR',  apiSymbol: 'PLTR',  type: 'stock', source: 'yahoo' },
  { symbol: 'UBER',  apiSymbol: 'UBER',  type: 'stock', source: 'yahoo' },
  { symbol: 'SHOP',  apiSymbol: 'SHOP',  type: 'stock', source: 'yahoo' },
  { symbol: 'SPOT',  apiSymbol: 'SPOT',  type: 'stock', source: 'yahoo' },
]

exports.getAll    = () => [...CRYPTO, ...STOCKS]
exports.getCrypto = () => CRYPTO
exports.getStocks = () => STOCKS

// Runtime version — user config takes precedence over built-in defaults
exports.getRuntimeAll = () => {
  const cfg = require('./config').load()
  if (cfg) return [...(cfg.crypto || []), ...(cfg.stocks || [])]
  return [...CRYPTO, ...STOCKS]
}
