const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const version = process.argv[2]

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: npm run release:version -- 1.1.0')
  process.exit(1)
}

function edit(rel, updater) {
  const target = path.join(root, rel)
  const text = fs.readFileSync(target, 'utf8')
  const next = updater(text)
  if (next !== text) fs.writeFileSync(target, next, 'utf8')
}

edit('package.json', text => {
  const json = JSON.parse(text)
  json.version = version
  return `${JSON.stringify(json, null, 2)}\n`
})

edit('renderer/src/App.jsx', text =>
  text.replace(/const APP_VERSION = 'v\d+\.\d+\.\d+'/g, `const APP_VERSION = 'v${version}'`)
)

edit('renderer/src/components/Toolbar.jsx', text =>
  text.replace(/>v\d+\.\d+\.\d+<\/span>/g, `>v${version}</span>`)
)

edit('renderer/src/components/SettingsPage.jsx', text =>
  text.replace(/v\d+\.\d+\.\d+/g, `v${version}`)
)

edit('README.md', text =>
  text.replace(/^# .+ v\d+\.\d+\.\d+/m, `# 市场 RSI 热力图 v${version}`)
)

console.log(`Version updated to ${version}`)
