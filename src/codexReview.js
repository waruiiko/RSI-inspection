const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

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
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  return `codex-review-${symbol}-${stamp}`
}

function buildScreenName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  const scope = slugify(payload?.scope || 'market')
  return `codex-screen-${scope}-${stamp}`
}

function buildLaunchReviewName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  const scope = slugify(payload?.scope || 'launch')
  return `codex-launch-${scope}-${stamp}`
}

function buildChatName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  const scope = slugify(payload?.scope || 'market-chat')
  return `codex-chat-${scope}-${stamp}`
}

function buildManagePlanName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
  const scope = slugify(payload?.scope || 'manage')
  return `codex-manage-${scope}-${stamp}`
}

function buildAlertPlanName(payload) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12)
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
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
      shell: process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command),
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    child.on('error', err => {
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\n${err.message}`.trim() })
    })

    child.on('close', code => {
      resolve({ ok: code === 0, exitCode: code, stdout, stderr })
    })

    child.stdin?.write(input)
    child.stdin?.end()
  })
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

function buildScreenPrompt(payload) {
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

function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(body)
  } catch (_) {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try { return JSON.parse(body.slice(start, end + 1)) } catch (_) {}
    }
  }
  return null
}

async function runScreen(payload, settings = {}) {
  const target = getCodexTarget(settings)
  const screenName = buildScreenName(payload)
  const screenDir = path.join(getScreenRoot(), screenName)
  const inputPath = path.join(screenDir, 'candidates.json')
  const promptPath = path.join(screenDir, 'prompt.md')
  const reportPath = path.join(screenDir, 'result.md')
  const resultPath = path.join(screenDir, 'result.json')
  const prompt = buildScreenPrompt(payload)

  fs.mkdirSync(screenDir, { recursive: true })
  fs.writeFileSync(inputPath, JSON.stringify(payload, null, 2), 'utf8')
  fs.writeFileSync(promptPath, prompt, 'utf8')

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'read-only',
    '--cd', screenDir,
    '--output-last-message', reportPath,
    '-',
  ]
  const result = await spawnCodex(target.command, [...target.argsPrefix, ...args], prompt, screenDir)

  if (!fs.existsSync(reportPath) && result.stdout.trim()) {
    fs.writeFileSync(reportPath, result.stdout.trim(), 'utf8')
  }

  const output = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : result.stdout
  const parsed = extractJson(output)
  if (parsed) fs.writeFileSync(resultPath, JSON.stringify(parsed, null, 2), 'utf8')

  return {
    ...result,
    ok: result.ok && !!parsed,
    screenName,
    screenDir,
    inputPath,
    promptPath,
    reportPath,
    resultPath: parsed ? resultPath : '',
    result: parsed,
    cliPath: target.display,
    parseError: parsed ? '' : 'Codex 输出不是可解析 JSON，请打开 result.md 查看原文。',
  }
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
  runScreen,
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
}
