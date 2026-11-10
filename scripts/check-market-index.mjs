// Validates the published market index with DSH's own parser (format 1).
// Run: node scripts/check-market-index.mjs [url|path]
// A local path is validated against the published URL as origin, because that
// is where the relative icon paths will resolve once the file is pushed.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PUBLISHED = 'https://raw.githubusercontent.com/kuangdang123/dsh-zotero/main/market/index.json'
const argument = process.argv[2]
const localPath = argument && existsSync(argument) ? resolve(argument) : null
const url = localPath ? PUBLISHED : argument ?? PUBLISHED

const modulePath = 'D:/Desktop/deepseek-harness/packages/util/plugin-market-index/lib/index.js'
const { parseMarketIndex, marketInstallTarget } = await import(pathToFileURL(modulePath).href)

let value
if (localPath) {
  console.log('READ', localPath, '(origin', url + ')')
  value = JSON.parse(readFileSync(localPath, 'utf8'))
} else {
  const response = await fetch(url)
  console.log('GET', url, '->', response.status, response.headers.get('content-type'))
  if (!response.ok) throw new Error(`index is not reachable: ${response.status}`)
  value = await response.json()
}

let index
try {
  index = parseMarketIndex(value, url)
} catch (error) {
  console.error('INVALID:', error.name, error.reason ?? error.message, 'at', error.path)
  process.exit(1)
}

console.log('format:', index.format)
console.log('title:', JSON.stringify(index.title))
console.log('metadata.categories:', Object.keys(index.metadata.categories).join(', '))
console.log('metadata.labels:', Object.keys(index.metadata.labels).join(', '))
for (const plugin of index.plugins) {
  console.log(`plugin ${plugin.name} | title ${JSON.stringify(plugin.title)} | icon ${plugin.icon}`)
  for (const version of plugin.versions) {
    const target = marketInstallTarget ? safeTarget(plugin, version) : undefined
    console.log(`  version ${version.version} | dsh ${JSON.stringify(version.engines)} | source ${version.source.type} ${version.source.url}#${String(version.source.commit).slice(0, 7)}`)
    console.log(`  install spec: ${target}`)
  }
}

function safeTarget(plugin, version) {
  try {
    const result = marketInstallTarget.length >= 2 ? marketInstallTarget(plugin, version) : marketInstallTarget(plugin.name, version.version)
    return typeof result === 'string' ? result : JSON.stringify(result)
  } catch (error) {
    return `(marketInstallTarget threw: ${error.message})`
  }
}