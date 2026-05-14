const fs = require('fs')
const path = require('path')

const distDir = path.join(__dirname, '..', 'dist')
if (!fs.existsSync(distDir)) {
  console.log('dist directory does not exist.')
  process.exit(0)
}

const installers = fs.readdirSync(distDir)
  .filter(name => /^市场RSI热力图 Setup .*\.exe$/.test(name))
  .map(name => {
    const file = path.join(distDir, name)
    return { name, file, mtime: fs.statSync(file).mtimeMs }
  })
  .sort((a, b) => b.mtime - a.mtime)

if (installers.length <= 1) {
  console.log('No old installers to remove.')
  process.exit(0)
}

const kept = installers[0]
const removed = []
for (const item of installers.slice(1)) {
  for (const file of [item.file, `${item.file}.blockmap`]) {
    if (!fs.existsSync(file)) continue
    fs.rmSync(file, { force: true })
    removed.push(path.basename(file))
  }
}

console.log(`Kept: ${kept.name}`)
console.log(`Removed ${removed.length} file(s):`)
for (const name of removed) console.log(`- ${name}`)
