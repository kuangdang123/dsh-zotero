/**
 * HTML in, text out (and a small Markdown subset in, HTML out).
 *
 * Zotero stores notes and abstracts as HTML. The agent needs readable text for
 * notes, and a safe converter for writing reading notes back into the library,
 * so both directions live here instead of being spread over the tools.
 */

const BLOCK_END = /<\/(?:p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|blockquote|pre|ul|ol|dl|dt|dd|table|figure|figcaption)\s*>/gi
const LINE_BREAK = /<br\s*\/?>/gi
const LIST_ITEM = /<li[^>]*>/gi
const HEADING_OPEN = /<h([1-6])[^>]*>/gi
const SCRIPT_OR_STYLE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi
const COMMENT = /<!--[\s\S]*?-->/g
const ANY_TAG = /<[^>]*>/g

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
}

/**
 * Decode the HTML entities that show up in reference-manager text.
 * @param text - HTML source.
 * @returns text with entities replaced.
 */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/**
 * Collapse runs of blank lines and trim each line.
 * @param text - plain text.
 * @returns normalized plain text.
 */
function normalizeWhitespace(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Convert Zotero note HTML into plain text, keeping paragraph, list, heading
 * and blockquote structure as line breaks and `- ` / `#` markers.
 * @param html - HTML fragment (a note, an abstract, a CSL preview).
 * @returns plain text.
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return ''
  let text = html.replace(COMMENT, '').replace(SCRIPT_OR_STYLE, '')
  text = text.replace(LINE_BREAK, '\n')
  text = text.replace(HEADING_OPEN, (_match, level) => `\n${'#'.repeat(Number(level))} `)
  text = text.replace(LIST_ITEM, '\n- ')
  text = text.replace(BLOCK_END, '\n')
  text = text.replace(ANY_TAG, '')
  return normalizeWhitespace(decodeEntities(text))
}

/**
 * Strip the JATS wrapper Crossref puts around abstracts.
 * @param value - abstract source, possibly JATS or plain text.
 * @returns plain abstract text.
 */
export function abstractToText(value) {
  if (typeof value !== 'string') return ''
  return normalizeWhitespace(decodeEntities(value.replace(ANY_TAG, '')))
}

/**
 * Escape text for use in HTML element content or attribute values.
 * @param value - raw text.
 * @returns escaped text.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the inline Markdown subset Zotero notes use: code, bold, italic, links.
 * @param text - already-escaped source text.
 * @returns HTML with inline elements.
 */
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
}

/**
 * Convert a Markdown subset into the HTML fragment Zotero stores in notes.
 *
 * Supported: headings, paragraphs, unordered/ordered lists, blockquotes,
 * fenced code blocks, horizontal rules, inline code, bold, italic, links.
 * Everything else passes through as escaped text.
 * @param markdown - note source.
 * @returns HTML fragment.
 */
export function markdownToNoteHtml(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n')
  if (source.trim() === '') return ''
  const lines = source.split('\n')
  const blocks = []
  let paragraph = []
  let list = null
  let quote = []
  let fence = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(`<p>${inlineMarkdown(escapeHtml(paragraph.join(' ')))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list === null) return
    const items = list.items.map(item => `<li>${inlineMarkdown(escapeHtml(item))}</li>`).join('')
    blocks.push(`<${list.tag}>${items}</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    const inner = quote.map(line => `<p>${inlineMarkdown(escapeHtml(line))}</p>`).join('')
    blocks.push(`<blockquote>${inner}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const line of lines) {
    const fenceMatch = /^\s*```(.*)$/.exec(line)
    if (fence !== null) {
      if (fenceMatch !== null) {
        blocks.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`)
        fence = null
      } else {
        fence.push(line)
      }
      continue
    }
    if (fenceMatch !== null) {
      flushAll()
      fence = []
      continue
    }

    if (line.trim() === '') {
      flushAll()
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushAll()
      const level = heading[1].length
      blocks.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2].trim()))}</h${level}>`)
      continue
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll()
      blocks.push('<hr/>')
      continue
    }

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (unordered !== null) {
      flushParagraph()
      flushQuote()
      if (list === null || list.tag !== 'ul') {
        flushList()
        list = { tag: 'ul', items: [] }
      }
      list.items.push(unordered[1].trim())
      continue
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      flushParagraph()
      flushQuote()
      if (list === null || list.tag !== 'ol') {
        flushList()
        list = { tag: 'ol', items: [] }
      }
      list.items.push(ordered[1].trim())
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted !== null) {
      flushParagraph()
      flushList()
      quote.push(quoted[1])
      continue
    }

    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }

  if (fence !== null) blocks.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`)
  flushAll()
  return blocks.join('\n')
}