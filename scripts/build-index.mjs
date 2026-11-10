#!/usr/bin/env node
/**
 * Regenerates the plugin-market index (`market/index.json`) for this repository.
 *
 * The index format is DSH's `dsh-plugin-market-index` format 1: a static JSON
 * document listing installable bundles with their display metadata and pinned
 * sources. Every version pins an exact Git commit, so the file must be rebuilt
 * and committed after each release: `npm run index`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
if (typeof repository !== 'string' || repository === '') {
  throw new Error('package.json needs a repository URL before the market index can be built')
}

const repositoryUrl = repository.replace(/^git\+/, '').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
if (!/^https:\/\/[^\s]+$/.test(repositoryUrl)) {
  throw new Error(`repository must be an absolute https URL, got "${repositoryUrl}"`)
}

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit id "${commit}"`)
const publishTimestamp = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim())
if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) {
  throw new Error('cannot read the commit time of HEAD')
}

const engines = pkg.engines?.dsh
if (typeof engines !== 'string' || engines.trim() === '') {
  throw new Error('package.json needs engines.dsh (a SemVer range, "*" for any DSH version)')
}

const index = {
  format: 1,
  title: { en: 'dsh-zotero', zh: 'dsh-zotero' },
  description: {
    en: 'Third-party DSH bundles published from guangdang/dsh-zotero.',
    zh: 'guangdang/dsh-zotero 发布的第三方 DSH 组合包。',
  },
  metadata: {
    categories: {
      literature: { title: { en: 'Literature', zh: '文献' } },
      productivity: { title: { en: 'Productivity', zh: '效率' } },
    },
    labels: {
      thirdparty: { title: { en: 'Third-party', zh: '第三方' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Zotero Bridge', zh: 'Zotero 直连' },
      description: {
        en: 'Connect a local Zotero library: search, read and edit items, add papers in bulk, and read PDF annotations, notes and indexed full text.',
        zh: '直连本机 Zotero：查库、改库、批量入库，读 PDF 注释与笔记，取已索引全文。',
      },
      icon: 'icon.svg',
      author: 'guangdang',
      homepage: `https://github.com/${repositoryUrl.split('/').slice(3, 5).join('/')}#readme`,
      repository: { url: repositoryUrl },
      metadata: {
        category: 'literature',
        labels: ['thirdparty'],
        keywords: pkg.keywords ?? [],
      },
      'dist-tags': { latest: pkg.version },
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source: { type: 'git', url: repositoryUrl, commit },
          engines: { dsh: engines },
        },
      ],
    },
  ],
}

const marketDir = join(root, 'market')
mkdirSync(marketDir, { recursive: true })
writeFileSync(join(marketDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
copyFileSync(join(root, 'icon.svg'), join(marketDir, 'icon.svg'))
console.log(`wrote market/index.json for ${pkg.name}@${pkg.version} at ${commit}`)