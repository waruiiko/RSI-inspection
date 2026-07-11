const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
let _activeChild = null
const _activeChildren = new Set()
let _cancelRequested = false
const _screenNarrativeCache = new Map()
const SCREEN_BATCH_SIZE = 24
const SCREEN_CACHE_TTL = 90 * 60 * 1000
const _screenCircuit = { failures: 0, openUntil: 0, lastProbeAt: 0 }
const _screenBudgetHistory = []
const SCREEN_VERSIONS = Object.freeze({
  pipeline: 'sh-ai-v3',
  schema: 'narrative-v2',
  prompt: 'narrative-v2',
  strategy: 'strict-entry-v2',
})

function getReviewRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-reviews')
}

function getScreenRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-screens')
}

function getLaunchReviewRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-launch-reviews')
}

function getChatRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-chat')
}

function getManagePlanRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-manage-plans')
}

function getAlertPlanRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-alert-plans')
}

function getCodexTarget(settings = {}) {
  const configured = String(settings.codexCliPath || 'codex').trim() || 'codex'
  const nodeExe = 'C:\\Program Files\\nodejs\\node.exe'
  const cliEntry = 'C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js'
  const directPrefix = `${nodeExe} ${cliEntry}`

  if (configured === 'codex' && fs.existsSync(nodeExe) && fs.existsSync(cliEntry)) {
    return { command: nodeExe, argsPrefix: [cliEntry], display: `${nodeExe} ${cliEntry}` }
  }

  if (configured.startsWith(directPrefix)) {
    const rest = configured.slice(directPrefix.length).trim()
    return {
      command: nodeExe,
      argsPrefix: [cliEntry, ...splitArgs(rest)],
      display: configured,
    }
  }

  return { command: configured, argsPrefix: [], display: configured }
}

function splitArgs(value) {
  return value ? value.split(/\s+/).filter(Boolean) : []
}

function slugify(value) {
  return String(value || 'review')
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'review'
}

function buildReviewName(payload) {
  const symbol = slugify(payload?.item?.symbol || 'review')
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  return `codex-review-${symbol}-${stamp}`
}

function buildScreenName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const scope = slugify(payload?.scope || 'market')
  return `codex-screen-${scope}-${stamp}`
}

function buildLaunchReviewName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const scope = slugify(payload?.scope || 'launch')
  return `codex-launch-${scope}-${stamp}`
}

function buildChatName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const scope = slugify(payload?.scope || 'market-chat')
  return `codex-chat-${scope}-${stamp}`
}

function buildManagePlanName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const scope = slugify(payload?.scope || 'manage')
  return `codex-manage-${scope}-${stamp}`
}

function buildAlertPlanName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const scope = slugify(payload?.scope || 'alerts')
  return `codex-alert-${scope}-${stamp}`
}

function buildPrompt(payload) {
  return [
    '你是 RSI-inspection 的交易提醒复盘助手。',
    '请基于下面的提醒快照，输出一份中文 Markdown 复盘报告。',
    '',
    '报告结构：',
    '1. 提醒摘要',
    '2. 当时为何触发',
    '3. 信号等级判断：观察 / 普通 / 强提醒，并说明理由',
    '4. 风险点',
    '5. 下一步观察重点',
    '6. 给非技术交易者也能看懂的一段结论',
    '',
    '要求：',
    '- 不要编造不存在的数据',
    '- 可以引用 JSON 字段',
    '- 如果数据不足，请明确写“数据不足”',
    '- 不要修改任何文件，只输出报告正文',
    '',
    '提醒快照 JSON：',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

function spawnCodex(command, args, input, cwd) {
  return new Promise(resolve => {
    if (!_activeChildren.size) _cancelRequested = false
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      shell: process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command),
    })
    _activeChild = child
    _activeChildren.add(child)

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (_activeChild === child) _activeChild = null
      _activeChildren.delete(child)
      resolve(_cancelRequested ? { ...result, ok: false, cancelled: true, stderr: 'Codex task cancelled' } : result)
    }
    const timeout = setTimeout(() => {
      terminateChild(child)
      finish({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nCodex task timed out after 4 minutes`.trim(), timedOut: true })
    }, 4 * 60 * 1000)

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    child.on('error', err => {
      finish({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${err.message}`.trim() })
    })

    child.on('close', code => {
      finish({ ok: code === 0, exitCode: code, stdout, stderr })
    })

    child.stdin?.write(input)
    child.stdin?.end()
  })
}

function terminateChild(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      killer.unref()
      return
    } catch {}
  }
  try { child.kill('SIGKILL') } catch {}
}

function cancelActive() {
  if (!_activeChildren.size) return false
  _cancelRequested = true
  for (const child of _activeChildren) terminateChild(child)
  return true
}

async function getStatus(settings = {}) {
  const target = getCodexTarget(settings)
  const result = await spawnCodex(target.command, [...target.argsPrefix, '--version'], '', process.cwd())
  return {
    ok: result.ok,
    cliPath: target.display,
    version: result.ok ? (result.stdout || result.stderr).trim() : '',
    error: result.ok ? '' : (result.stderr || result.stdout || 'Unable to run codex'),
    reviewRoot: getReviewRoot(),
  }
}

async function runReview(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const reviewName = buildReviewName(payload)
  const reviewDir = path.join(getReviewRoot(), reviewName)
  const inputPath = path.join(reviewDir, 'review.json')
  const promptPath = path.join(reviewDir, 'prompt.md')
  const reportPath = path.join(reviewDir, 'report.md')
  const prompt = buildPrompt(payload)

  fs.mkdirSync(reviewDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', reviewDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, reviewDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  return {
    ...result,
    ok: result.ok && fs.existsSync(reportPath),
    reviewName,
    reviewDir,
    inputPath,
    promptPath,
    reportPath,
    cliPath: target.display,
  }
}

function buildSignalHunterScreenPrompt(payload) {
  return [
    '你是 Signal Hunter 的结构说明助手。本地程序已经决定方向、周期、关键位和执行状态。',
    '你只能为每个候选补充简短中文结构摘要、风险说明和标签，不得改变 deterministicPlan。',
    '严格输出符合 Schema 的 JSON，不要 Markdown，不要代码块，不要调用工具。',
    '每个输入 key 必须且只能返回一次。摘要最多 80 字，风险最多 50 字，标签最多 4 个。',
    '',
    '输入 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
  /* Legacy prompt retained below for compatibility reference. */
  return [
    '你是 RSI-inspection 的 Signal Hunter 形态识别助手。',
    '任务：本地规则已经决定是否存在结构、方向、周期和关键位。你只负责解释 deterministicPlan、补充风险叙事并给出辅助评分，不得重写交易计划。',
    '这不是交易建议，不要鼓励下单，不要使用外部新闻、基本面或链上数据。',
    '不要调用任何工具或命令；只根据下面的输入生成最终 JSON。',
    '',
    '请严格输出 JSON，不要 Markdown，不要代码块。',
    'JSON 格式：',
    '{',
    '  "summary": "一句话说明本批候选质量",',
    '  "items": [',
    '    {',
    '      "key": "source:apiSymbol，可直接复制输入里的 key",',
    '      "symbol": "BTC",',
    '      "status": "armed | wait_entry | triggered | watch | risk | rejected",',
    '      "side": "long | short",',
    '      "timeframe": "1h | 4h",',
    '      "entryMode": "pullback | retest | base | breakout | breakdown",',
    '      "setup": "pullback_long | rebound_short | base_long | base_short | retest_long | retest_short | range_break | ai_structure",',
    '      "setupLabel": "中文形态名，最多 12 字",',
    '      "entryPrice": 0,',
    '      "confirmPrice": 0,',
    '      "stopLoss": 0,',
    '      "targets": [0, 0, 0],',
    '      "rewardRisk": 1.5,',
    '      "score": { "total": 0, "chart": 0, "data": 0, "risk": 0 },',
    '      "reasons": ["最多 5 条中文依据"],',
    '      "riskFlags": ["最多 8 条中文风险"],',
    '      "narrativeSummary": "基于输入快照的一段中文叙事摘要，最多 120 字",',
    '      "narrativeTags": ["最多 5 个中文叙事标签"],',
    '      "rejectReasons": []',
    '    }',
    '  ]',
    '}',
    '',
    '硬性规则：',
    '- 每个输入候选都必须返回一个 item；看不懂结构就 status=rejected，并写 rejectReasons。',
    '- 非 rejected 的 rewardRisk 必须 >= 1.5，目标位必须来自结构空间，不要机械按固定百分比外推。',
    '- Signal Hunter 只允许 1h 或 4h；不要输出 15m，因为用户无法执行 15m 级别计划。',
    '- deterministicPlan 非空时，side、timeframe、entryMode、setup、entryPrice、confirmPrice、stopLoss、targets 必须逐值照抄；AI 不得另选方向、周期或关键位。',
    '- deterministicPlan 为空时必须返回 rejected，并写明“本地规则没有形成可执行结构”。',
    '- entryMode 必填：回踩/反抽用 pullback，支阻回测用 retest，区间蓄势用 base，向上突破用 breakout，向下跌破用 breakdown。入场价与现价的触发关系必须符合该模型。',
    '- 非 rejected 的股票/TradFi 候选必须考虑真实执行：失效距离不能贴着入场价。50 美元以下股票 1h 至少约 $0.70 或 2.5%，4h 还要更宽；不满足就 rejected 并说明“失效距离过窄”。',
    '- total、chart、data 均使用 0-10 分并分别判断，可保留一位小数：total 是综合评分，chart 是图表结构评分，data 是成交额、RSI、OI、资金费率等数据评分。risk 可为 -3 到 2。综合分低于 7 的必须 rejected。',
    '- riskFlags 尽量完整：检查流动性、量能、RSI 过热或过冷、OI 与资金费率、拥挤度、结构失效距离、目标空间、数据缺失。没有证据不要编造风险。',
    '- narrativeSummary 用于后续扩展美股。只根据输入快照概括当前结构、数据特征和需要继续观察的变量；不得虚构新闻、公告、社区热度或公司基本面。narrativeTags 用短标签表达主题。',
    '- 做多：失效价必须低于入场价，目标位必须高于入场价。做空：失效价必须高于入场价，目标位必须低于入场价。',
    '- triggered 必须按 entryMode 判断：breakout 做多现价上穿入场、breakdown 做空现价下穿入场；pullback/retest/base 则是做多回落到入场或做空反抽到入场。',
    '- 对 pullback/retest/base，如果匹配的本地 timeframeCandidates 明确给出 entryTouched=false，不得标 triggered；应使用 armed 或 wait_entry。',
    '- 影线碰到不等于有效触发：回踩/反抽需要触碰后收盘重新站回入场位的有效一侧；breakout/breakdown 需要已闭合K线收在突破位之外。',
    '- 如果现价已经越过 stopLoss，或首次发现时已经从入场位运行过远，不得作为新机会，返回 rejected。',
    '- 程序会对刚止损的同标的、同方向、同周期、同入场模型执行冷却；AI 不应把未重建的原结构包装成新机会。',
    '- rewardRisk 会由程序按入场、失效价和第二目标重新计算；不得虚报。目标必须按距离入场由近到远排列且不能重复。',
    '- 优先识别：突破后回踩、支阻互换、震荡区上下沿、三角/旗形收敛、反抽做空、回踩做多。',
    '- 不要为了凑数量而给机会；没有结构、R 不够、量能/资金不配合，都 rejected。',
    '',
    '输入 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

function buildScreenPrompt(payload) {
  if (String(payload?.scope || '').startsWith('signal-hunter')) return buildSignalHunterScreenPrompt(screenPromptPayload(payload))
  return [
    '你是 RSI-inspection 的市场候选筛选助手。',
    '你的任务不是给买卖建议，也不是预测价格；你只负责把本地规则筛出来的候选进一步分类，帮助用户减少噪音。',
    '',
    '请严格输出 JSON，不要 Markdown，不要代码块。',
    'JSON 格式：',
    '{',
    '  "summary": "一句话说明这批候选整体状态",',
    '  "items": [',
    '    {',
    '      "symbol": "BTC",',
    '      "decision": "focus | watch | ignore | risk",',
    '      "confidence": 0,',
    '      "reason": "为什么这样分类，最多 40 个中文字符",',
    '      "risk": "主要风险，最多 40 个中文字符",',
    '      "next_check": "下一步看什么，最多 40 个中文字符"',
    '    }',
    '  ]',
    '}',
    '',
    '分类标准：',
    '- focus：信号相对集中，值得用户优先打开图表确认。',
    '- watch：有信号，但仍需要等待更多确认。',
    '- ignore：噪音较大，暂时不值得打扰用户。',
    '- risk：波动或结构风险较高，只提示风险，不作为机会。',
    '',
    '约束：',
    '- 只使用输入 JSON 里的数据，不要编造新闻、基本面或链上数据。',
    '- 不要出现“买入、卖出、做多、做空、止盈、止损”等交易指令。',
    '- 每个输入候选都必须返回一个对应 item。',
    '- confidence 用 0-100 的整数。',
    '- 如果 derivatives 字段存在，请重点判断 OI、资金费率、价格位置是否支持该信号。',
    '- opportunityStage 可作为候选阶段参考：early=早发现，entry_window=入场窗口，pullback_watch=确认/回踩候选，risk=风险区。',
    '',
    '输入 JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

function buildShadowScreenPrompt(payload) {
  return [
    '你是Signal Hunter的影子叙述评估器。执行结构由本地程序决定，你不得修改。',
    '请用更具体、少套话的中文说明当前结构证据、最大不确定性和下一项观察变量。',
    '严格输出Schema JSON；每个key只返回一次；不得出现买卖或下单指令。',
    '输入JSON：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

function screenPromptPayload(payload) {
  if (!String(payload?.scope || '').startsWith('signal-hunter')) return payload
  return {
    scope: payload.scope,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    note: payload.note,
    candidates: (payload.candidates ?? []).map(candidate => ({
      key: candidate.key,
      symbol: candidate.symbol,
      apiSymbol: candidate.apiSymbol,
      source: candidate.source,
      type: candidate.type,
      price: candidate.price,
      change24h: candidate.change24h,
      turnover: candidate.turnover,
      preferredTimeframe: candidate.preferredTimeframe,
      rsi: candidate.rsi,
      signalScore: candidate.signalScore,
      volumeSignal: candidate.volumeSignal,
      derivatives: candidate.derivatives ? {
        oiChange1h: candidate.derivatives.oiChange1h,
        oiChange4h: candidate.derivatives.oiChange4h,
        oiChange24h: candidate.derivatives.oiChange24h,
        fundingRate: candidate.derivatives.fundingRate,
        priceChange1h: candidate.derivatives.priceChange1h,
        priceChange4h: candidate.derivatives.priceChange4h,
        stage: candidate.derivatives.stage,
        label: candidate.derivatives.label,
        reasons: candidate.derivatives.reasons,
      } : null,
      liquidity: candidate.liquidity ? {
        spreadPct: candidate.liquidity.spreadPct,
        topBookNotional: candidate.liquidity.topBookNotional,
        source: candidate.liquidity.source,
      } : null,
      marketSession: candidate.marketSession,
      dataQuality: candidate.dataQuality,
      deterministicPlan: candidate.deterministicPlan,
      priority: candidate.priority,
    })),
  }
}

function extractJson(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw) return null
  const candidates = [raw, ...[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim())]
  for (const body of candidates) {
    try { return JSON.parse(body) } catch (_) {}
    for (let start = 0; start < body.length; start += 1) {
      if (body[start] !== '{' && body[start] !== '[') continue
      const stack = []; let quoted = false; let escaped = false
      for (let index = start; index < body.length; index += 1) {
        const char = body[index]
        if (quoted) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') quoted = false
          continue
        }
        if (char === '"') { quoted = true; continue }
        if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
          const open = stack.pop()
          if ((open === '{' && char !== '}') || (open === '[' && char !== ']')) break
          if (!stack.length) {
            try { return JSON.parse(body.slice(start, index + 1)) } catch (_) { break }
          }
        }
      }
    }
  }
  return null
}

function screenOutputSchema(scope) {
  if (String(scope || '').startsWith('signal-hunter')) {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'items'],
      properties: {
        summary: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'symbol', 'narrativeSummary', 'riskNarrative', 'narrativeTags'],
            properties: {
              key: { type: 'string' },
              symbol: { type: 'string' },
              narrativeSummary: { type: 'string' },
              riskNarrative: { type: 'string' },
              narrativeTags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'items'],
    properties: {
      summary: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['symbol', 'decision', 'confidence', 'reason', 'risk', 'next_check'],
          properties: {
            symbol: { type: 'string' },
            decision: { type: 'string', enum: ['focus', 'watch', 'ignore', 'risk'] },
            confidence: { type: 'integer', minimum: 0, maximum: 100 },
            reason: { type: 'string' },
            risk: { type: 'string' },
            next_check: { type: 'string' },
          },
        },
      },
    },
  }
}

function deterministicScreenFallback(payload, reason) {
  if (!String(payload?.scope || '').startsWith('signal-hunter')) return null
  const items = (payload.candidates ?? []).flatMap(candidate => {
    const plan = candidate.deterministicPlan
    if (!plan) return []
    return [{
      ...plan,
      key: candidate.key,
      symbol: candidate.symbol,
      score: plan.score ?? { total: 0, chart: 0, data: 0, risk: 0 },
      reasons: plan.reasons ?? [],
      riskFlags: plan.riskFlags ?? [],
      narrativeSummary: '',
      narrativeTags: [],
      rejectReasons: plan.rejectReasons ?? [],
    }]
  })
  if (!items.length) return null
  return {
    summary: 'AI 解释暂不可用，当前显示本地确定性结构。',
    items,
    _meta: { degraded: true, reason },
  }
}

function screenCandidateSignature(candidate) {
  const compactNumber = value => Number.isFinite(Number(value)) ? Number(Number(value).toPrecision(4)) : null
  const plan = candidate.deterministicPlan
  return JSON.stringify({
    key: candidate.key,
    price: compactNumber(candidate.price),
    rsi: Object.fromEntries(Object.entries(candidate.rsi ?? {}).map(([key, value]) => [key, Math.round(Number(value) * 10) / 10])),
    derivatives: candidate.derivatives && {
      oiChange1h: compactNumber(candidate.derivatives.oiChange1h),
      oiChange4h: compactNumber(candidate.derivatives.oiChange4h),
      fundingRate: compactNumber(candidate.derivatives.fundingRate),
    },
    plan: plan && {
      status: plan.status, side: plan.side, timeframe: plan.timeframe, entryMode: plan.entryMode,
      setup: plan.setup, entryPrice: compactNumber(plan.entryPrice), stopLoss: compactNumber(plan.stopLoss),
      targets: (plan.targets ?? []).map(compactNumber), executionEligible: plan.executionEligible,
    },
  })
}

function persistedNarrativeItem(candidate, previousRunAt, now = Date.now(), ttlMs = SCREEN_CACHE_TTL, versions = null) {
  const prior = candidate.localSignalHunter
  const plan = candidate.deterministicPlan
  if (!sameScreenVersions(versions) || !prior?.narrativeSummary || !plan || now - Number(previousRunAt || 0) >= ttlMs) return null
  const sameIdentity = prior.side === plan.side && prior.timeframe === plan.timeframe &&
    prior.entryMode === plan.entryMode && prior.setup === plan.setup
  const priorEntry = Number(prior.entryPrice)
  const nextEntry = Number(plan.entryPrice)
  const entryDrift = Number.isFinite(priorEntry) && Number.isFinite(nextEntry) && priorEntry !== 0
    ? Math.abs(nextEntry - priorEntry) / Math.abs(priorEntry)
    : Infinity
  if (!sameIdentity || entryDrift > 0.0025) return null
  return {
    key: candidate.key, symbol: candidate.symbol,
    narrativeSummary: prior.narrativeSummary,
    riskNarrative: prior.riskNarrative ?? '',
    narrativeTags: prior.narrativeTags ?? [],
  }
}

function chunkScreenCandidates(candidates, size = SCREEN_BATCH_SIZE) {
  const batches = []
  for (let i = 0; i < candidates.length; i += size) batches.push(candidates.slice(i, i + size))
  return batches
}

function screenRuntimeOptions(settings = {}) {
  const profile = settings.shAiProfile === 'fast' ? 'fast' : settings.shAiProfile === 'custom' ? 'custom' : 'stable'
  const preset = profile === 'fast'
    ? { batchSize: 24, concurrency: 2, cacheMinutes: 60, retries: 1 }
    : { batchSize: 18, concurrency: 1, cacheMinutes: 120, retries: 1 }
  const budget = {
    hourlyBatches: Math.max(1, Number(settings.shAiHourlyBatches) || 12),
    hourlyCandidates: Math.max(10, Number(settings.shAiHourlyCandidates) || 240),
    hourlyMinutes: Math.max(5, Number(settings.shAiHourlyMinutes) || 30),
  }
  if (profile !== 'custom') return { profile, ...preset, ...budget }
  return {
    profile,
    batchSize: Math.max(6, Math.min(30, Number(settings.shAiBatchSize) || 18)),
    concurrency: Math.max(1, Math.min(2, Number(settings.shAiConcurrency) || 1)),
    cacheMinutes: Math.max(15, Math.min(240, Number(settings.shAiCacheMinutes) || 120)),
    retries: Math.max(0, Math.min(2, Number(settings.shAiRetries) || 1)),
    ...budget,
  }
}

function screenBudgetRemaining(options, now = Date.now()) {
  while (_screenBudgetHistory.length && now - _screenBudgetHistory[0].at >= 60 * 60 * 1000) _screenBudgetHistory.shift()
  const used = _screenBudgetHistory.reduce((sum, item) => ({
    batches: sum.batches + item.batches,
    candidates: sum.candidates + item.candidates,
    durationMs: sum.durationMs + item.durationMs,
  }), { batches: 0, candidates: 0, durationMs: 0 })
  return {
    batches: Math.max(0, options.hourlyBatches - used.batches),
    candidates: Math.max(0, options.hourlyCandidates - used.candidates),
    durationMs: Math.max(0, options.hourlyMinutes * 60 * 1000 - used.durationMs),
    used,
  }
}

function sameScreenVersions(value, expected = SCREEN_VERSIONS) {
  return Object.entries(expected).every(([key, version]) => value?.[key] === version)
}

function prioritizeScreenCandidates(candidates) {
  const statusWeight = { triggered: 0, armed: 1, wait_entry: 2, watch: 3, risk: 4, rejected: 5 }
  return [...candidates].sort((a, b) => {
    const ap = a.deterministicPlan ?? {}
    const bp = b.deterministicPlan ?? {}
    return Number(Boolean(bp.executionEligible)) - Number(Boolean(ap.executionEligible)) ||
      (statusWeight[ap.status] ?? 9) - (statusWeight[bp.status] ?? 9) ||
      Math.abs(Number(ap.distanceToEntryPct ?? 999)) - Math.abs(Number(bp.distanceToEntryPct ?? 999)) ||
      Number(b.priority ?? 0) - Number(a.priority ?? 0)
  })
}

function validNarrativeItem(item, expectedKeys) {
  if (!item || !expectedKeys.has(item.key)) return false
  const summary = String(item.narrativeSummary || '').trim()
  const risk = String(item.riskNarrative || '').trim()
  if (summary.length < 6 || risk.length < 4) return false
  if (/买入|卖出|下单|做多|做空|止损/.test(`${summary} ${risk}`)) return false
  const tags = Array.isArray(item.narrativeTags) ? item.narrativeTags.map(String) : []
  return new Set(tags).size === tags.length
}

function classifyScreenFailure(result, output, parsed) {
  if (result?.cancelled) return 'cancelled'
  if (result?.timedOut) return 'timeout'
  if (/schema|validation|does not match/i.test(String(result?.stderr || ''))) return 'schema_mismatch'
  if (/unexpected end|truncat|\bEOF\b/i.test(String(result?.stderr || ''))) return 'truncated_output'
  if (!result?.ok) return 'process_error'
  if (!String(output || '').trim()) return 'empty_output'
  if (!parsed && /[\[{]/.test(String(output)) && !/[\]}]\s*$/.test(String(output).trim())) return 'truncated_output'
  if (!parsed) return 'invalid_json'
  return ''
}

function canonicalScreenResult(payload, aiItems, diagnostics = {}) {
  const byKey = new Map()
  let duplicates = 0
  for (const item of aiItems ?? []) {
    const key = String(item?.key || '').trim()
    if (!key) continue
    if (byKey.has(key)) duplicates += 1
    else byKey.set(key, item)
  }
  let missing = 0
  const candidateKeys = new Set((payload.candidates ?? []).map(candidate => candidate.key))
  const unexpected = [...byKey.keys()].filter(key => !candidateKeys.has(key)).length
  const items = (payload.candidates ?? []).map(candidate => {
    const ai = byKey.get(candidate.key)
    if (!ai) missing += 1
    const plan = candidate.deterministicPlan ?? {
      status: 'rejected', side: 'long', timeframe: '1h', entryMode: 'pullback',
      setup: 'ai_structure', setupLabel: '无本地结构', entryPrice: 0,
      confirmPrice: 0, stopLoss: 0, targets: [], rewardRisk: 0,
      score: { total: 0, chart: 0, data: 0, risk: 0 },
      reasons: [], riskFlags: [], rejectReasons: ['本地规则没有形成可执行结构'],
    }
    return {
      ...plan,
      key: candidate.key,
      symbol: candidate.symbol,
      score: plan.score ?? { total: 0, chart: 0, data: 0, risk: 0 },
      reasons: plan.reasons ?? [],
      riskFlags: plan.riskFlags ?? [],
      rejectReasons: plan.rejectReasons ?? [],
      narrativeSummary: String(ai?.narrativeSummary ?? '').trim().slice(0, 160),
      riskNarrative: String(ai?.riskNarrative ?? '').trim().slice(0, 100),
      narrativeTags: Array.isArray(ai?.narrativeTags)
        ? ai.narrativeTags.map(value => String(value).trim()).filter(Boolean).slice(0, 4)
        : [],
    }
  })
  return {
    summary: diagnostics.degraded ? '部分AI说明不可用，已保留本地确定性结构。' : 'AI说明已完成，本地执行结构未被修改。',
    items,
    _meta: { ...diagnostics, missing, duplicates, unexpected },
  }
}

async function runScreenBatch(target, payload, batchDir, schemaPath, promptBuilder = buildScreenPrompt) {
  fs.mkdirSync(batchDir, { recursive: true })
  const prompt = promptBuilder(payload)
  const promptPath = path.join(batchDir, 'prompt.md')
  const reportPath = path.join(batchDir, 'result.md')
  fs.writeFileSync(promptPath, prompt, 'utf8')
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--cd', batchDir, '--output-schema', schemaPath, '--output-last-message', reportPath, '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, batchDir)
  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : ''
  const parsed = extractJson(output)
  return { result, output, parsed, failure: classifyScreenFailure(result, output, parsed), reportPath }
}

async function runScreen(payload, settings = {}, onProgress = () => {}) {
  const target = getCodexTarget(settings)
  const screenName = buildScreenName(payload)
  const screenDir = path.join(getScreenRoot(), screenName)
  const inputPath = path.join(screenDir, 'candidates.json')
  const promptPath = path.join(screenDir, 'prompt.md')
  const reportPath = path.join(screenDir, 'result.md')
  const resultPath = path.join(screenDir, 'result.json')
  const schemaPath = path.join(screenDir, 'schema.json')
  const prompt = buildScreenPrompt(payload)

  fs.mkdirSync(screenDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')
  fs.writeFileSync(schemaPath, JSON.stringify(screenOutputSchema(payload?.scope), null, 2), 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', screenDir,
    '--output-schema', schemaPath,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, screenDir)

  if (!fs.existsSync(reportPath)) {
    const report = result.ok
      ? result.stdout.trim()
      : `Codex execution failed.\n${result.stderr || 'No model response was produced.'}`.trim()
    if (report) fs.writeFileSync(reportPath, report, 'utf8')
  }

  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : result.stdout
  const parsedOutput = extractJson(output)
  const failureReason = parsedOutput ? '' : 'Codex 未返回符合 Schema 的 JSON'
  const fallback = parsedOutput || result.cancelled ? null : deterministicScreenFallback(payload, failureReason)
  const parsed = parsedOutput ?? fallback
  if (parsed) fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2), 'utf8')

  return {
    ...result,
    ok: !!parsed,
    degraded: Boolean(fallback),
    retryable: Boolean(fallback),
    screenName,
    screenDir,
    inputPath,
    promptPath,
    reportPath,
    resultPath: parsed ? resultPath : '',
    result: parsed,
    cliPath: target.display,
    parseError: parsedOutput ? '' : fallback
      ? 'AI 输出异常，已保留本地确定性信号；可打开 result.md 查看原文。'
      : 'Codex 输出不是可解析 JSON，请打开 result.md 查看原文。',
  }
}

async function runScreenBatched(payload, settings = {}, onProgress = () => {}) {
  _cancelRequested = false
  const target = getCodexTarget(settings)
  const runVersions = { ...SCREEN_VERSIONS, model: settings.codexModel || 'default', cli: target.display }
  const screenName = buildScreenName(payload)
  const screenDir = path.join(getScreenRoot(), screenName)
  const inputPath = path.join(screenDir, 'candidates.json')
  const promptPath = path.join(screenDir, 'prompt.md')
  const reportPath = path.join(screenDir, 'result.md')
  const resultPath = path.join(screenDir, 'result.json')
  const schemaPath = path.join(screenDir, 'schema.json')
  fs.mkdirSync(screenDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, buildScreenPrompt(screenPromptPayload(payload)), 'utf8')
  fs.writeFileSync(schemaPath, JSON.stringify(screenOutputSchema(payload?.scope), null, 2), 'utf8')
  const startedAt = Date.now()
  const options = screenRuntimeOptions(settings)
  const cacheTtlMs = options.cacheMinutes * 60 * 1000
  const candidates = payload.candidates ?? []
  const cachedItems = []
  const pending = []
  const dataFiltered = []
  const refreshReasons = []
  for (const candidate of candidates) {
    const signature = screenCandidateSignature(candidate)
    const cached = _screenNarrativeCache.get(candidate.key)
    if (cached && sameScreenVersions(cached.versions, runVersions) && cached.signature === signature && startedAt - cached.at < cacheTtlMs) cachedItems.push(cached.item)
    else {
      const persisted = persistedNarrativeItem(candidate, payload.previousAiRunAt, startedAt, cacheTtlMs, payload.previousAiVersions && sameScreenVersions(payload.previousAiVersions, runVersions) ? runVersions : null)
      if (persisted) cachedItems.push(persisted)
      else {
        if (candidate.dataQuality?.ok === false || !candidate.deterministicPlan) dataFiltered.push(candidate)
        else pending.push(candidate)
        refreshReasons.push({
          key: candidate.key,
          reason: !cached && !candidate.localSignalHunter?.narrativeSummary ? 'new_candidate'
            : (cached && !sameScreenVersions(cached.versions, runVersions)) || !sameScreenVersions(payload.previousAiVersions, runVersions) ? 'version_changed'
              : cached && startedAt - cached.at >= cacheTtlMs ? 'cache_expired'
                : 'market_or_structure_changed',
        })
      }
    }
  }
  const prioritized = prioritizeScreenCandidates(pending)
  const adaptiveBatchSize = _screenCircuit.failures ? Math.max(6, Math.floor(options.batchSize / 2)) : options.batchSize
  let queued = prioritized
  const circuitOpen = startedAt < _screenCircuit.openUntil
  const mayProbe = payload.healthProbe || startedAt - _screenCircuit.lastProbeAt >= 10 * 60 * 1000
  if (circuitOpen) {
    queued = mayProbe ? prioritized.slice(0, 4) : []
    if (mayProbe) _screenCircuit.lastProbeAt = startedAt
  }
  const circuitQueued = [...queued]
  const circuitDeferredCandidates = prioritized.slice(circuitQueued.length)
  const budget = screenBudgetRemaining(options, startedAt)
  const maxByBatches = budget.batches * adaptiveBatchSize
  const allowedCandidates = Math.min(queued.length, budget.candidates, maxByBatches)
  queued = budget.durationMs > 0 ? queued.slice(0, allowedCandidates) : []
  const budgetDeferredCandidates = circuitQueued.slice(queued.length)
  const deferredByBudget = budgetDeferredCandidates.length
  const deferredByCircuit = circuitDeferredCandidates.length
  const batches = chunkScreenCandidates(queued, adaptiveBatchSize)
  const aiItems = [...cachedItems]
  const failures = []
  if (dataFiltered.length) failures.push({ label: 'data-quality', type: 'data_quality', count: dataFiltered.length, keys: dataFiltered.map(item => item.key) })
  let retries = 0
  let completed = cachedItems.length + dataFiltered.length
  onProgress({
    phase: 'start', completed, total: candidates.length, batch: 0, batches: batches.length, cached: cachedItems.length,
    items: [
      ...cachedItems.map(item => ({ key: item.key, status: 'cached' })),
      ...queued.map(item => ({ key: item.key, status: 'queued' })),
      ...dataFiltered.map(item => ({ key: item.key, status: 'data_blocked' })),
    ],
  })
  const execute = async (batch, label, retriesLeft = options.retries) => {
    if (_cancelRequested) return
    const attempt = await runScreenBatch(target, screenPromptPayload({ ...payload, candidates: batch }), path.join(screenDir, label), schemaPath)
    const expectedKeys = new Set(batch.map(candidate => candidate.key))
    const keyCounts = new Map()
    for (const item of attempt.parsed?.items ?? []) keyCounts.set(item?.key, (keyCounts.get(item?.key) ?? 0) + 1)
    const validItems = (attempt.parsed?.items ?? []).filter(item => validNarrativeItem(item, expectedKeys) && keyCounts.get(item.key) === 1)
    const validKeys = new Set(validItems.map(item => item.key))
    aiItems.push(...validItems)
    completed += validItems.length
    const missingBatch = batch.filter(candidate => !validKeys.has(candidate.key))
    if (validItems.length) onProgress({ phase: 'items', items: validItems.map(item => ({ key: item.key, status: 'completed' })) })
    if (!missingBatch.length) return
    if (retriesLeft > 0 && !attempt.result.cancelled) {
      retries += 1
      onProgress({ phase: 'items', items: missingBatch.map(item => ({ key: item.key, status: 'retrying' })) })
      const retrySize = Math.max(1, Math.ceil(missingBatch.length / 2))
      const retryBatches = chunkScreenCandidates(missingBatch, retrySize)
      for (let i = 0; i < retryBatches.length; i += 1) await execute(retryBatches[i], `${label}-repair-${i + 1}`, retriesLeft - 1)
      return
    }
    failures.push({ label, type: attempt.failure || (attempt.parsed ? 'narrative_quality' : 'schema_mismatch'), count: missingBatch.length, keys: missingBatch.map(item => item.key) })
    onProgress({ phase: 'items', items: missingBatch.map(item => ({ key: item.key, status: 'degraded' })) })
    completed += missingBatch.length
  }
  let nextBatch = 0
  const worker = async () => {
    while (!_cancelRequested) {
      const index = nextBatch++
      if (index >= batches.length) return
      onProgress({ phase: 'batch', completed, total: candidates.length, batch: index + 1, batches: batches.length, cached: cachedItems.length, items: batches[index].map(item => ({ key: item.key, status: 'running' })) })
      await execute(batches[index], `batch-${index + 1}`)
      onProgress({ phase: 'batch-complete', completed, total: candidates.length, batch: index + 1, batches: batches.length, cached: cachedItems.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, batches.length)) }, worker))
  if (deferredByCircuit) {
    failures.push({ label: 'circuit', type: 'circuit_open', count: deferredByCircuit, keys: circuitDeferredCandidates.map(item => item.key) })
    completed += deferredByCircuit
    onProgress({ phase: 'items', items: circuitDeferredCandidates.map(item => ({ key: item.key, status: 'circuit_deferred' })) })
  }
  if (deferredByBudget > 0) {
    failures.push({ label: 'budget', type: 'budget_deferred', count: deferredByBudget, keys: budgetDeferredCandidates.map(item => item.key) })
    completed += deferredByBudget
    onProgress({ phase: 'items', items: budgetDeferredCandidates.map(item => ({ key: item.key, status: 'budget_deferred' })) })
  }
  const realFailures = failures.filter(item => !['circuit_open', 'budget_deferred', 'data_quality'].includes(item.type))
  if (realFailures.length) {
    _screenCircuit.failures += 1
    if (_screenCircuit.failures >= 3) _screenCircuit.openUntil = Date.now() + 30 * 60 * 1000
  } else if (batches.length) {
    _screenCircuit.failures = 0
    _screenCircuit.openUntil = 0
  }
  let shadow = null
  if (settings.shAiShadowEnabled && !_cancelRequested && queued.length) {
    const shadowCandidates = queued.slice(0, 4)
    const shadowStartedAt = Date.now()
    const shadowAttempt = await runScreenBatch(
      target,
      screenPromptPayload({ ...payload, candidates: shadowCandidates }),
      path.join(screenDir, 'shadow-sample'),
      schemaPath,
      buildShadowScreenPrompt,
    )
    const expected = new Set(shadowCandidates.map(item => item.key))
    const valid = (shadowAttempt.parsed?.items ?? []).filter(item => validNarrativeItem(item, expected))
    shadow = {
      promptVersion: 'narrative-shadow-v1',
      samples: shadowCandidates.length,
      valid: valid.length,
      completeness: shadowCandidates.length ? Math.round(valid.length / shadowCandidates.length * 100) : 0,
      durationMs: Date.now() - shadowStartedAt,
      failure: shadowAttempt.failure || '',
    }
  }
  const degraded = failures.length > 0
  const parsed = canonicalScreenResult(payload, aiItems, {
    degraded, cancelled: _cancelRequested, failures, retries,
    cached: cachedItems.length, resumed: cachedItems.length, requested: queued.length, batches: batches.length,
    profile: options.profile, batchSize: adaptiveBatchSize, concurrency: options.concurrency,
    cacheLayers: { execution: candidates.length, narrative: cachedItems.length, marketFeatures: queued.length },
    versions: runVersions,
    snapshotId: payload.snapshotId ?? null,
    refreshReasons,
    shadow,
    budget: { ...budget, deferred: Math.max(0, deferredByBudget) },
    circuitOpen: Date.now() < _screenCircuit.openUntil, circuitFailures: _screenCircuit.failures,
    durationMs: Date.now() - startedAt,
  })
  for (const candidate of candidates) {
    const item = aiItems.find(value => value.key === candidate.key)
    if (item) _screenNarrativeCache.set(candidate.key, { signature: screenCandidateSignature(candidate), item, at: Date.now(), versions: runVersions })
  }
  _screenBudgetHistory.push({ at: Date.now(), batches: batches.length + retries, candidates: queued.length, durationMs: Date.now() - startedAt })
  fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2), 'utf8')
  fs.writeFileSync(reportPath, JSON.stringify(failures.length ? { failures } : { ok: true, items: aiItems.length }, null, 2), 'utf8')
  onProgress({ phase: _cancelRequested ? 'cancelled' : 'complete', completed, total: candidates.length, batch: batches.length, batches: batches.length, cached: cachedItems.length })
  return {
    ok: true,
    cancelled: _cancelRequested,
    degraded,
    retryable: false,
    screenName, screenDir, inputPath, promptPath, reportPath,
    resultPath, result: parsed, cliPath: target.display,
    diagnostics: parsed._meta,
    versions: runVersions,
    parseError: degraded ? `部分批次失败：${failures.map(item => `${item.type}(${item.count})`).join('、')}` : '',
  }
}

function runScreenDispatch(payload, settings = {}, onProgress) {
  return String(payload?.scope || '').startsWith('signal-hunter')
    ? runScreenBatched(payload, settings, onProgress)
    : runScreen(payload, settings)
}

function getScreenRuntimeState(settings = {}) {
  const options = screenRuntimeOptions(settings)
  let directories = []
  try { directories = fs.readdirSync(getScreenRoot(), { withFileTypes: true }).filter(entry => entry.isDirectory()) } catch {}
  return {
    narrativeCache: _screenNarrativeCache.size,
    activeProcesses: _activeChildren.size,
    circuit: { ..._screenCircuit, remainingMs: Math.max(0, _screenCircuit.openUntil - Date.now()) },
    budget: screenBudgetRemaining(options),
    queuedTasks: directories.length,
    versions: SCREEN_VERSIONS,
  }
}

function resetScreenRuntime(scope = 'all') {
  if (scope === 'all' || scope === 'cache') _screenNarrativeCache.clear()
  if (scope === 'all' || scope === 'circuit') Object.assign(_screenCircuit, { failures: 0, openUntil: 0, lastProbeAt: 0 })
  if (scope === 'all' || scope === 'budget') _screenBudgetHistory.splice(0)
  return { ok: true, scope }
}

function cleanupScreenRuns({ keep = 50, maxAgeDays = 14 } = {}) {
  const root = getScreenRoot()
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, path: path.join(root, entry.name), mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch { return { ok: true, removed: 0, remaining: 0 } }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const removable = entries.filter((entry, index) => index >= keep || entry.mtimeMs < cutoff)
  for (const entry of removable) fs.rmSync(entry.path, { recursive: true, force: true })
  return { ok: true, removed: removable.length, remaining: entries.length - removable.length }
}

function buildLaunchReviewPrompt(payload) {
  return [
    '你是 RSI-inspection 的启动复盘助手。',
    '你的任务是复盘一批已经进入“启动、回踩或风险区”的候选，帮助用户判断后续是否继续观察。',
    '',
    '请输出中文 Markdown 报告，不要给买卖指令，不要使用“买入、卖出、做多、做空、止盈、止损”等交易指令。',
    '',
    '报告结构：',
    '1. 市场启动概览',
    '2. 值得继续盯的候选',
    '3. 已经过热或风险较高的候选',
    '4. 可能等待回踩确认的候选',
    '5. 接下来 1-4 小时观察清单',
    '6. 数据不足或不确定的地方',
    '',
    '判断重点：',
    '- OI 是否继续增长，还是只是空头回补',
    '- 资金费率是否拥挤',
    '- 从首次出现到现在的涨跌是否已经过大',
    '- 量价结构和 RSI 是否支持继续观察',
    '- 哪些更像早期启动，哪些更像追高风险',
    '',
    '输入 JSON：',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n')
}

async function runLaunchReview(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const reviewName = buildLaunchReviewName(payload)
  const reviewDir = path.join(getLaunchReviewRoot(), reviewName)
  const inputPath = path.join(reviewDir, 'launch-review.json')
  const promptPath = path.join(reviewDir, 'prompt.md')
  const reportPath = path.join(reviewDir, 'report.md')
  const prompt = buildLaunchReviewPrompt(payload)

  fs.mkdirSync(reviewDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', reviewDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, reviewDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  return {
    ...result,
    ok: result.ok && fs.existsSync(reportPath),
    reviewName,
    reviewDir,
    inputPath,
    promptPath,
    reportPath,
    cliPath: target.display,
  }
}

function buildMarketChatPrompt(payload) {
  return [
    '你是 RSI-inspection 内嵌的行情上下文聊天助手。',
    '你只能基于输入 JSON 中的当前界面状态、市场候选、AI 快照、信号轨迹和提醒记录回答。',
    '',
    '你的职责：',
    '- 帮用户筛选真正值得继续观察的标的',
    '- 解释 RSI、量价、OI、资金费率、信号轨迹和 AI 筛选结果',
    '- 提醒风险和下一步观察点',
    '',
    '限制：',
    '- 不要编造新闻、链上数据、社媒数据或不存在的行情。',
    '- 不要给交易指令，不要使用“买入、卖出、做多、做空、止盈、止损”等措辞。',
    '- 如果数据不足，请直接说数据不足，并说明还需要看什么。',
    '- 回答要简洁、中文、适合交易观察。',
    '',
    `用户问题：${payload?.question ?? ''}`,
    '',
    '当前上下文 JSON：',
    '```json',
    JSON.stringify(payload?.context ?? {}, null, 2),
    '```',
  ].join('\n')
}

async function runMarketChat(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const chatName = buildChatName(payload)
  const chatDir = path.join(getChatRoot(), chatName)
  const inputPath = path.join(chatDir, 'context.json')
  const promptPath = path.join(chatDir, 'prompt.md')
  const reportPath = path.join(chatDir, 'answer.md')
  const prompt = buildMarketChatPrompt(payload)

  fs.mkdirSync(chatDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', chatDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, chatDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  const answer = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : result.stdout
  return {
    ...result,
    ok: result.ok && !!answer.trim(),
    chatName,
    chatDir,
    inputPath,
    promptPath,
    reportPath,
    answer: answer.trim(),
    cliPath: target.display,
  }
}

function buildManagePlanPrompt(payload) {
  return [
    '你是 RSI-inspection 的品种管理助手。',
    '你的任务是根据用户指令和当前品种上下文，生成“批量操作预案”。',
    '注意：你不能直接修改配置，只能输出严格 JSON，由软件展示给用户确认后再应用。',
    '',
    '请严格输出 JSON，不要 Markdown，不要代码块，不要解释性前后缀。',
    '',
    'JSON Schema:',
    '{',
    '  "summary": "一句话说明这个预案会做什么",',
    '  "risk": "可能的风险或需要用户确认的点",',
    '  "actions": [',
    '    {',
    '      "target": "crypto | stocks",',
    '      "mode": "add | remove | set",',
    '      "apiSymbols": ["BTCUSDT"],',
    '      "reason": "为什么这样操作"',
    '    }',
    '  ],',
    '  "groups": [',
    '    {',
    '      "name": "重点观察",',
    '      "mode": "replace | add",',
    '      "apiSymbols": ["BTCUSDT"],',
    '      "reason": "为什么这样分组"',
    '    }',
    '  ]',
    '}',
    '',
    '约束:',
    '- 只能使用输入 JSON 中存在的 apiSymbol，不要编造标的。',
    '- crypto 目标只使用 availableCrypto 中的 apiSymbol。',
    '- stocks 目标只使用 knownStocks 中的 apiSymbol。',
    '- 如果用户要求“只保留/保留 Top N”，请使用 mode=set。',
    '- 如果用户要求“加入/增加”，请使用 mode=add。',
    '- 如果用户要求“移除/取消/删除”，请使用 mode=remove。',
    '- apiSymbols 数量可以为空，但必须说明原因。',
    '- 不要给交易建议，只处理观察列表和分组管理。',
    '',
    `用户指令: ${payload?.instruction ?? ''}`,
    '',
    '当前上下文 JSON:',
    JSON.stringify(payload?.context ?? {}, null, 2),
  ].join('\n')
}

async function runManagePlan(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const planName = buildManagePlanName(payload)
  const planDir = path.join(getManagePlanRoot(), planName)
  const inputPath = path.join(planDir, 'context.json')
  const promptPath = path.join(planDir, 'prompt.md')
  const reportPath = path.join(planDir, 'plan.md')
  const resultPath = path.join(planDir, 'plan.json')
  const prompt = buildManagePlanPrompt(payload)

  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', planDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, planDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : result.stdout
  const parsed = extractJson(output)
  if (parsed) fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2), 'utf8')

  return {
    ...result,
    ok: result.ok && !!parsed,
    planName,
    planDir,
    inputPath,
    promptPath,
    reportPath,
    resultPath: parsed ? resultPath : '',
    plan: parsed,
    cliPath: target.display,
    parseError: parsed ? '' : 'Codex 输出不是可解析 JSON，请打开 plan.md 查看原文。',
  }
}

function buildAlertPlanPrompt(payload) {
  return [
    '你是 RSI-inspection 的提醒规则助手。',
    '你的任务是根据用户指令、当前市场快照和已有提醒规则，生成“提醒规则预案”。',
    '注意：你不能直接修改配置，只能输出严格 JSON，由软件展示给用户确认后再应用。',
    '',
    '请严格输出 JSON，不要 Markdown，不要代码块，不要解释性前后缀。',
    '',
    'JSON Schema:',
    '{',
    '  "summary": "一句话说明这个预案会建立什么提醒",',
    '  "risk": "可能过严、过松、噪音过多或覆盖旧规则的风险",',
    '  "rules": [',
    '    {',
    '      "symbols": ["BTC"],',
    '      "timeframes": ["1h", "4h"],',
    '      "alertLevel": 1,',
    '      "requireAllTf": false,',
    '      "followTop": false,',
    '      "followTopLimit": null,',
    '      "rsiAbove": null,',
    '      "rsiBelow": null,',
    '      "changeAbove": null,',
    '      "changeBelow": null,',
    '      "priceAbove": null,',
    '      "priceBelow": null,',
    '      "divBull": false,',
    '      "divBear": false,',
    '      "volumeSignal": true,',
    '      "strategies": ["breakout", "breakdown", "volume_divergence"],',
    '      "minScore": 3,',
    '      "reason": "为什么这样设置"',
    '    }',
    '  ]',
    '}',
    '',
    '约束:',
    '- 只能使用输入 JSON 中 allowedSymbols 里的 symbol，不要编造标的。',
    '- timeframes 只能使用 15m、1h、4h、1d。',
    '- alertLevel 只能是 1、2、3；1=普通提醒，2=重要提醒，3=强提醒。',
    '- requireAllTf=true 表示所选周期全部同时满足时额外触发特殊提醒；单周期满足仍会触发普通提醒。',
    '- strategies 只能使用 breakout、breakdown、volume_divergence。',
    '- 如果使用策略提醒，请设置 volumeSignal=true，并给出 strategies 与 minScore。',
    '- 如果使用自定义 RSI/涨跌/背离提醒，可以设置 volumeSignal=false。',
    '- 批量规则尽量不要生成 priceAbove/priceBelow，除非用户明确要求价格提醒。',
    '- 如果 context.feedback 中某类规则被标为“噪音”，请提高阈值、提高 minScore 或降低提醒等级；“太早”增加确认周期；“太晚”增加 1h/15m 前置信号；“有用”保留相似结构。',
    '- 每条规则至少要包含 RSI、涨跌幅、背离、价格或量价结构中的一种条件。',
    '- 不要给交易建议，只生成提醒规则预案。',
    '',
    `用户指令: ${payload?.instruction ?? ''}`,
    '',
    '当前上下文 JSON:',
    JSON.stringify(payload?.context ?? {}, null, 2),
  ].join('\n')
}

async function runAlertPlan(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const planName = buildAlertPlanName(payload)
  const planDir = path.join(getAlertPlanRoot(), planName)
  const inputPath = path.join(planDir, 'context.json')
  const promptPath = path.join(planDir, 'prompt.md')
  const reportPath = path.join(planDir, 'plan.md')
  const resultPath = path.join(planDir, 'plan.json')
  const prompt = buildAlertPlanPrompt(payload)

  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', planDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, planDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : result.stdout
  const parsed = extractJson(output)
  if (parsed) fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2), 'utf8')

  return {
    ...result,
    ok: result.ok && !!parsed,
    planName,
    planDir,
    inputPath,
    promptPath,
    reportPath,
    resultPath: parsed ? resultPath : '',
    plan: parsed,
    cliPath: target.display,
    parseError: parsed ? '' : 'Codex 输出不是可解析 JSON，请打开 plan.md 查看原文。',
  }
}

module.exports = {
  getStatus,
  runReview,
  runScreen: runScreenDispatch,
  runLaunchReview,
  runMarketChat,
  runManagePlan,
  runAlertPlan,
  getReviewRoot,
  getScreenRoot,
  getLaunchReviewRoot,
  getChatRoot,
  getManagePlanRoot,
  getAlertPlanRoot,
  cancelActive,
  getScreenRuntimeState,
  resetScreenRuntime,
  cleanupScreenRuns,
  __test: { extractJson, screenOutputSchema, deterministicScreenFallback, screenPromptPayload, canonicalScreenResult, classifyScreenFailure, chunkScreenCandidates, persistedNarrativeItem, screenRuntimeOptions, prioritizeScreenCandidates, validNarrativeItem, sameScreenVersions, screenBudgetRemaining, buildShadowScreenPrompt, SCREEN_VERSIONS },
}
