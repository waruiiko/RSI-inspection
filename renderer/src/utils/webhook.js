function fmtItem(item) {
  if (item.type === 'ai') {
    const label = item.condition === 'focus' ? '重点' : item.condition === 'risk' ? '风险' : '观察'
    const confidence = item.value != null ? `  置信度 ${item.value}` : ''
    const reason = item.reason ? `  ${item.reason}` : ''
    const next = item.nextCheck ? `  看点：${item.nextCheck}` : ''
    return `${item.symbol}  AI筛选：${label}${confidence}${reason}${next}`
  }
  if (item.type === 'divergence') {
    const dir = item.condition === 'bull' ? '牛市背离' : '熊市背离'
    return `${item.symbol}  (${item.timeframe}) 检测到${dir}`
  }
  if (item.type === 'structure') {
    const ratio = item.volumeRatio != null ? `  量能 ${item.volumeRatio}x` : ''
    const move = item.priceMovePct != null ? `  K线 ${item.priceMovePct > 0 ? '+' : ''}${item.priceMovePct}%` : ''
    return `${item.symbol}  (${item.timeframe}) ${item.signal ?? '量价结构'}  评分 ${item.value}${ratio}${move}`
  }
  const dir = item.condition === 'above' ? '↑' : '↓'
  if (item.type === 'rsi')
    return `${item.symbol}  RSI(${item.timeframe}) ${dir} ${item.threshold}  当前 ${item.value?.toFixed(1) ?? '—'}`
  if (item.type === 'price')
    return `${item.symbol}  价格 ${dir} ${item.threshold}  当前 ${item.value}`
  const mag = Math.abs(item.threshold)
  return `${item.symbol}  24h${dir} ${mag}%  当前 ${item.value > 0 ? '+' : ''}${item.value?.toFixed(2) ?? '—'}%`
}

const MAX_TG = 4000

export async function sendWebhooks(items, settings) {
  if (!items.length) return
  const { telegramToken, telegramChatId, discordWebhook } = settings

  const lines = items.map(fmtItem).filter(Boolean)
  if (!lines.length) return
  const text = lines.join('\n')

  if (telegramToken && telegramChatId) {
    const body = `🔔 RSI 提醒\n${text}`.slice(0, MAX_TG)
    fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: String(telegramChatId).trim(), text: body }),
    })
      .then(async r => {
        if (!r.ok) console.warn('[webhook/telegram]', r.status, await r.text())
      })
      .catch(e => console.warn('[webhook/telegram]', e.message))
  }

  if (discordWebhook) {
    const content = `🔔 **RSI 提醒**\n\`\`\`\n${text}\n\`\`\``.slice(0, 2000)
    fetch(discordWebhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ content }),
    })
      .then(async r => {
        if (!r.ok) console.warn('[webhook/discord]', r.status, await r.text())
      })
      .catch(e => console.warn('[webhook/discord]', e.message))
  }
}
