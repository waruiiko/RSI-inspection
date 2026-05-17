const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

function getReviewRoot() {
  return path.join(os.homedir(), '.rsi-inspection', 'codex-reviews')
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

module.exports = {
  getStatus,
  runReview,
  getReviewRoot,
}
