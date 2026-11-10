/**
 * Turn Zotero API objects into the compact text the model reads.
 *
 * Every result is plain text because the tools declare a string output schema;
 * the formats here stay stable so snapshots and prompts keep working.
 */
import { abstractToText, htmlToText } from './html.js'

/** Zotero's default annotation colors, keyed by lower-case hex. */
const ANNOTATION_COLORS = {
  '#ffd400': 'yellow',
  '#ff6666': 'red',
  '#5fb236': 'green',
  '#2ea8e5': 'blue',
  '#a28ae5': 'purple',
  '#e56eee': 'magenta',
  '#f19837': 'orange',
  '#aaaaaa': 'gray',
}

/** Fields worth showing in a one-line search result, in display order. */
const SHORT_FIELDS = ['publicationTitle', 'conferenceName', 'bookTitle', 'publisher', 'university', 'repository']

/**
 * Read the item payload from an API object, tolerating a bare `data` object.
 * @param object - an item response, its `data`, or null.
 * @returns the item data object, or an empty object.
 */
export function itemData(object) {
  if (object === null || typeof object !== 'object') return {}
  const data = object.data
  return data !== null && typeof data === 'object' ? data : object
}

/**
 * Format one creator the way a citation line wants it.
 * @param creator - a Zotero creator entry.
 * @returns display text.
 */
export function creatorName(creator) {
  if (creator === null || typeof creator !== 'object') return ''
  if (typeof creator.name === 'string' && creator.name.trim() !== '') return creator.name.trim()
  const last = typeof creator.lastName === 'string' ? creator.lastName.trim() : ''
  const first = typeof creator.firstName === 'string' ? creator.firstName.trim() : ''
  if (last !== '' && first !== '') return `${last}, ${first}`
  return last !== '' ? last : first
}

/**
 * Join creators into a single citation fragment.
 * @param creators - the item's creator array.
 * @param limit - how many names to show before `et al.`.
 * @returns display text, or an empty string.
 */
export function creatorsLine(creators, limit = 6) {
  const list = Array.isArray(creators) ? creators : []
  const names = list.map(creatorName).filter(name => name !== '')
  if (names.length === 0) return ''
  if (names.length <= limit) return names.join('; ')
  return `${names.slice(0, limit).join('; ')}; et al. (${names.length} total)`
}

/**
 * Read tag names from an item data object.
 * @param data - item data.
 * @returns tag names in stored order.
 */
export function tagNames(data) {
  const tags = Array.isArray(data?.tags) ? data.tags : []
  return tags
    .map(tag => (typeof tag === 'string' ? tag : tag?.tag))
    .filter(tag => typeof tag === 'string' && tag !== '')
}

/**
 * Pick the venue-ish field an item type uses.
 * @param data - item data.
 * @returns the first populated venue field, or an empty string.
 */
function venueOf(data) {
  for (const field of SHORT_FIELDS) {
    const value = data[field]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * Trim text to a budget and say so, so no single field can dominate a result.
 * @param text - source text.
 * @param max - maximum characters to keep.
 * @returns the kept text, with a truncation marker when shortened.
 */
export function truncate(text, max) {
  const value = typeof text === 'string' ? text : ''
  if (value.length <= max) return value
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`
}

/**
 * Clamp a whole result to a byte-independent character budget.
 * @param lines - already formatted lines.
 * @param max - maximum characters in the joined result.
 * @returns the joined text and how many lines were kept.
 */
export function joinBudgeted(lines, max) {
  const kept = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > max) break
    kept.push(line)
    used += line.length + 1
  }
  const omitted = lines.length - kept.length
  const text = kept.join('\n')
  return omitted === 0 ? text : `${text}\n… ${omitted} more line(s) omitted (raise maxChars or narrow the query)`
}

/**
 * Describe an attachment's file kind in one or two words.
 * @param data - attachment item data.
 * @returns a short label.
 */
export function attachmentLabel(data) {
  const contentType = typeof data.contentType === 'string' ? data.contentType : ''
  if (contentType === 'application/pdf') return 'PDF'
  if (contentType.startsWith('text/html')) return 'HTML'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType !== '') return contentType
  return data.linkMode === 'linked_url' ? 'linked page' : 'file'
}

/**
 * One-line summary of an item for search results and listings.
 * @param object - item response object.
 * @param index - 1-based position in the current listing.
 * @returns a single line of text.
 */
export function itemLine(object, index) {
  const data = itemData(object)
  const parts = []
  parts.push(`${index}. [${object?.key ?? data.key ?? '?'}] ${data.itemType ?? 'item'}`)
  const date = typeof data.date === 'string' ? data.date.trim() : ''
  if (date !== '') parts.push(date)
  const creators = creatorsLine(data.creators, 3)
  if (creators !== '') parts.push(creators)
  const rawTitle = typeof data.title === 'string' && data.title.trim() !== ''
    ? data.title
    : typeof data.note === 'string' ? data.note : ''
  if (data.itemType === 'annotation') {
    const page = annotationPage(data)
    if (page !== '') parts.push(`· ${page}`)
    const quote = annotationQuote(data)
    parts.push(`· ${quote !== '' ? `"${truncate(quote, 140)}"` : '(annotation)'}`)
  } else if (data.itemType === 'attachment') {
    parts.push(`· ${attachmentLabel(data)}${typeof data.filename === 'string' && data.filename !== '' ? ` · ${data.filename}` : ''}`)
  } else {
    parts.push(`· ${rawTitle !== '' ? truncate(htmlToText(rawTitle), 160) : '(untitled)'}`)
  }
  const venue = venueOf(data)
  if (venue !== '') parts.push(`· ${truncate(venue, 90)}`)
  if (typeof data.DOI === 'string' && data.DOI !== '') parts.push(`· DOI ${data.DOI}`)
  if (data.deleted === true) parts.push('· IN TRASH')
  const tags = tagNames(data)
  if (tags.length > 0) parts.push(`· tags: ${truncate(tags.join(', '), 120)}`)
  return parts.join(' ').replace(/\s+/g, ' ')
}

/**
 * Format the abstract of an item as a wrapped block.
 * @param data - item data.
 * @param max - maximum characters.
 * @returns the abstract text, or an empty string.
 */
function abstractOf(data, max) {
  const value = typeof data.abstractNote === 'string' ? data.abstractNote : ''
  if (value.trim() === '') return ''
  return truncate(abstractToText(value), max)
}

/**
 * Build the full detail block for one item.
 * @param object - item response object.
 * @param options - extra context: collection names, children, full text, bibtex.
 * @returns markdown-ish detail text.
 */
export function itemDetail(object, options = {}) {
  const data = itemData(object)
  const lines = []
  const title = typeof data.title === 'string' && data.title.trim() !== ''
    ? data.title.trim()
    : data.itemType === 'note'
      ? '(note)'
      : data.itemType === 'annotation'
        ? truncate(annotationQuote(data), 120) || '(annotation)'
        : '(untitled)'
  lines.push(`# ${title}`)
  const facts = [
    `key: ${object?.key ?? data.key ?? '?'}`,
    `type: ${data.itemType ?? '?'}`,
    `version: ${object?.version ?? data.version ?? '?'}`,
  ]
  if (typeof data.date === 'string' && data.date !== '') facts.push(`date: ${data.date}`)
  if (data.deleted === true) facts.push('state: IN TRASH')
  lines.push(facts.join(' · '))

  if (typeof data.parentItem === 'string' && data.parentItem !== '') {
    const label = typeof options.parentLabel === 'string' && options.parentLabel !== ''
      ? ` ${options.parentLabel}`
      : ''
    lines.push(`parent: [${data.parentItem}]${label}`)
  }

  const creators = creatorsLine(data.creators, 12)
  if (creators !== '') lines.push(`creators: ${creators}`)

  const venue = venueOf(data)
  const meta = []
  if (venue !== '') meta.push(venue)
  if (typeof data.volume === 'string' && data.volume !== '') meta.push(`vol ${data.volume}`)
  if (typeof data.issue === 'string' && data.issue !== '') meta.push(`no ${data.issue}`)
  if (typeof data.pages === 'string' && data.pages !== '') meta.push(`pp ${data.pages}`)
  if (meta.length > 0) lines.push(`venue: ${meta.join(' · ')}`)

  const ids = []
  if (typeof data.DOI === 'string' && data.DOI !== '') ids.push(`DOI ${data.DOI}`)
  if (typeof data.ISBN === 'string' && data.ISBN !== '') ids.push(`ISBN ${data.ISBN}`)
  if (typeof data.ISSN === 'string' && data.ISSN !== '') ids.push(`ISSN ${data.ISSN}`)
  if (typeof data.url === 'string' && data.url !== '') ids.push(data.url)
  if (ids.length > 0) lines.push(`links: ${ids.join(' · ')}`)

  const tags = tagNames(data)
  if (tags.length > 0) lines.push(`tags: ${tags.join(', ')}`)

  const collectionKeys = Array.isArray(data.collections) ? data.collections : []
  if (collectionKeys.length > 0) {
    const known = options.collectionNames instanceof Map ? options.collectionNames : new Map()
    const named = collectionKeys.map((key) => {
      const name = known.get(key)
      return name === undefined ? key : `${name} [${key}]`
    })
    lines.push(`collections: ${named.join(' · ')}`)
  }

  const abstract = abstractOf(data, options.abstractMax ?? 1600)
  if (abstract !== '') lines.push('', '## Abstract', abstract)

  if (typeof data.extra === 'string' && data.extra.trim() !== '') {
    lines.push('', '## Extra', truncate(data.extra.trim(), 1200))
  }
  if (data.itemType === 'note' && typeof data.note === 'string') {
    lines.push('', '## Note', truncate(htmlToText(data.note), 6000))
  }
  if (data.itemType === 'annotation') {
    lines.push('', '## Annotation', annotationBlock(object, 1))
  }

  const children = Array.isArray(options.children) ? options.children : []
  if (children.length > 0) {
    lines.push('', `## Children (${children.length})`)
    let attachments = 0
    let notes = 0
    let annotations = 0
    for (const child of children) {
      const childData = itemData(child)
      if (childData.itemType === 'annotation') {
        annotations += 1
        continue
      }
      if (childData.itemType === 'note') {
        notes += 1
        lines.push(`- note [${child.key}] ${truncate(firstLine(htmlToText(childData.note)), 400)}`)
        continue
      }
      if (childData.itemType === 'attachment') {
        attachments += 1
        lines.push(`- attachment [${child.key}] ${attachmentLabel(childData)} · ${childData.filename ?? childData.title ?? '(no filename)'}`)
        continue
      }
      lines.push(`- ${childData.itemType ?? 'item'} [${child.key}] ${childData.title ?? ''}`)
    }
    const counts = []
    if (attachments > 0) counts.push(`${attachments} attachment(s)`)
    if (notes > 0) counts.push(`${notes} note(s)`)
    if (annotations > 0) counts.push(`${annotations} annotation(s)`)
    if (counts.length > 0) lines.push('', `summary: ${counts.join(' · ')}`)
  }

  if (typeof options.fulltext === 'string' && options.fulltext !== '') {
    lines.push('', '## Indexed full text', options.fulltext)
  }
  if (typeof options.bibtex === 'string' && options.bibtex.trim() !== '') {
    lines.push('', '## BibTeX', options.bibtex.trim())
  }
  return lines.join('\n')
}

/**
 * First non-empty line of a text block.
 * @param text - source text.
 * @returns the first line, or an empty string.
 */
function firstLine(text) {
  const line = String(text ?? '').split('\n').find(candidate => candidate.trim() !== '')
  return line === undefined ? '' : line.trim()
}

/**
 * Quote an annotation shows: its highlighted text, or its comment.
 * @param data - annotation data.
 * @returns flattened quote text, or an empty string.
 */
export function annotationQuote(data) {
  const text = typeof data.annotationText === 'string' ? data.annotationText.trim() : ''
  const source = text !== ''
    ? text
    : typeof data.annotationComment === 'string' ? data.annotationComment.trim() : ''
  return source.replace(/\s+/g, ' ')
}

/**
 * Extract the page number an annotation sits on.
 * @param data - annotation data.
 * @returns a display label such as `p.12`, or an empty string.
 */
export function annotationPage(data) {
  const label = typeof data.annotationPageLabel === 'string' ? data.annotationPageLabel.trim() : ''
  if (label !== '') return `p.${label}`
  if (typeof data.annotationPosition === 'string' && data.annotationPosition !== '') {
    try {
      const position = JSON.parse(data.annotationPosition)
      if (Number.isInteger(position?.pageIndex)) return `pageIndex ${position.pageIndex}`
      if (Array.isArray(position) && Number.isInteger(position[0]?.pageIndex)) return `pageIndex ${position[0].pageIndex}`
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Human color name for an annotation color.
 * @param color - hex color string.
 * @returns the Zotero color name, or the raw value.
 */
export function annotationColorName(color) {
  if (typeof color !== 'string' || color === '') return 'uncolored'
  return ANNOTATION_COLORS[color.toLowerCase()] ?? color
}

/**
 * Render one annotation as a Markdown block.
 * @param object - annotation item response object.
 * @param index - 1-based annotation number in the transcript.
 * @returns markdown text for the annotation.
 */
export function annotationBlock(object, index) {
  const data = itemData(object)
  const kind = typeof data.annotationType === 'string' ? data.annotationType : 'annotation'
  const page = annotationPage(data)
  const head = [`[${index}]`, kind, annotationColorName(data.annotationColor)]
  if (page !== '') head.push(`· ${page}`)
  const lines = [head.join(' ')]
  const quote = typeof data.annotationText === 'string' ? data.annotationText.trim() : ''
  if (quote !== '') {
    const quoted = truncate(quote, 1400).split('\n').map(line => `> ${line}`).join('\n')
    lines.push(quoted)
  }
  const comment = typeof data.annotationComment === 'string' ? data.annotationComment.trim() : ''
  if (comment !== '') lines.push('', `${kind === 'note' ? 'note' : 'comment'}: ${truncate(comment, 2000)}`)
  const tags = tagNames(data)
  if (tags.length > 0) lines.push('', `tags: ${tags.join(', ')}`)
  if (data.annotationIsExternal === true) lines.push('', 'external annotation (imported from a PDF reader)')
  return lines.join('\n')
}

/**
 * Sort annotations in reading order using Zotero's zero-padded sort index.
 * @param objects - annotation response objects.
 * @returns a new array in reading order.
 */
export function sortAnnotations(objects) {
  return [...objects].sort((left, right) => {
    const a = itemData(left)
    const b = itemData(right)
    const aIndex = typeof a.annotationSortIndex === 'string' ? a.annotationSortIndex : ''
    const bIndex = typeof b.annotationSortIndex === 'string' ? b.annotationSortIndex : ''
    if (aIndex !== bIndex) return aIndex < bIndex ? -1 : 1
    return String(left.key ?? '').localeCompare(String(right.key ?? ''))
  })
}

/**
 * Count annotations by type and color for a transcript header.
 * @param objects - annotation response objects.
 * @returns a short summary string.
 */
export function annotationSummary(objects) {
  const byType = new Map()
  const byColor = new Map()
  for (const object of objects) {
    const data = itemData(object)
    const kind = typeof data.annotationType === 'string' ? data.annotationType : 'annotation'
    byType.set(kind, (byType.get(kind) ?? 0) + 1)
    const color = annotationColorName(data.annotationColor)
    byColor.set(color, (byColor.get(color) ?? 0) + 1)
  }
  const parts = []
  if (byType.size > 0) {
    parts.push([...byType.entries()].map(([kind, count]) => `${count} ${kind}`).join(', '))
  }
  if (byColor.size > 0) {
    parts.push([...byColor.entries()].map(([color, count]) => `${count} ${color}`).join(', '))
  }
  return parts.join(' · ')
}

/**
 * Escape a value for a BibTeX field.
 * @param value - raw field text.
 * @returns the escaped text.
 */
function bibtexEscape(value) {
  return String(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[{}]/g, match => (match === '{' ? '\\{' : '\\}'))
    .replace(/[&%$#_]/g, match => `\\${match}`)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Derive a stable citation key: first author's surname, the year, and the
 * first meaningful title word.
 * @param data - Zotero item data.
 * @returns a BibTeX-safe key.
 */
function bibtexKey(data) {
  const authors = Array.isArray(data.creators) ? data.creators : []
  const first = authors.find(creator => creator && creator.creatorType === 'author') ?? authors[0] ?? {}
  const surname = String(first.lastName ?? first.name ?? 'anon').replace(/[^A-Za-z0-9]/g, '')
  const year = String(data.date ?? '').match(/\d{4}/)?.[0] ?? 'nd'
  const words = String(data.title ?? 'untitled').split(/\s+/)
    .map(word => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter(word => word.length > 3 && !/^(with|from|that|this|into|using|based|toward|towards|about|learning|deep)$/i.test(word))
  return `${(surname || 'anon').toLowerCase()}${year}${(words[0] ?? 'untitled').toLowerCase()}`
}

const BIBTEX_ENTRY_TYPE = {
  journalArticle: 'article',
  magazineArticle: 'article',
  newspaperArticle: 'article',
  conferencePaper: 'inproceedings',
  book: 'book',
  bookSection: 'incollection',
  thesis: 'phdthesis',
  report: 'techreport',
  manuscript: 'unpublished',
}

/**
 * Render one Zotero item as a BibTeX entry.
 * @param item - a Zotero item response object.
 * @returns the entry, or a short note when the item type has no useful mapping.
 */
export function toBibtex(item) {
  const data = itemData(item)
  const entryType = BIBTEX_ENTRY_TYPE[data.itemType] ?? 'misc'
  const authors = (Array.isArray(data.creators) ? data.creators : [])
    .filter(creator => creator && (creator.creatorType === 'author' || creator.creatorType === 'editor'))
    .map(creator => (creator.lastName && creator.firstName
      ? `${creator.lastName}, ${creator.firstName}`
      : creator.name ?? creator.lastName ?? ''))
    .filter(name => name !== '')
  const fields = []
  const add = (name, value) => {
    if (value === undefined || value === null) return
    const text = String(value).trim()
    if (text === '') return
    fields.push(`  ${name} = {${bibtexEscape(text)}}`)
  }
  add('author', authors.join(' and '))
  add('title', data.title)
  add(entryType === 'article' ? 'journal' : entryType === 'inproceedings' ? 'booktitle' : 'booktitle',
    data.publicationTitle ?? data.proceedingsTitle ?? data.bookTitle)
  add('year', String(data.date ?? '').match(/\d{4}/)?.[0])
  add('volume', data.volume)
  add('number', data.issue ?? data.number)
  add('pages', data.pages)
  add('publisher', data.publisher)
  add('address', data.place)
  add('edition', data.edition)
  add('institution', data.institution ?? data.university)
  add('doi', data.DOI)
  add('url', data.url)
  add('isbn', data.ISBN)
  add('issn', data.ISSN)
  add('language', data.language)
  return `@${entryType}{${bibtexKey(data)},\n${fields.join(',\n')}\n}`
}