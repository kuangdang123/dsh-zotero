/**
 * External scholarly metadata sources used to fill the Zotero library.
 *
 * Every provider returns the same candidate object so the tools can rank,
 * display and convert results without knowing where they came from:
 *
 * ```
 * { source, sourceId, itemType, title, creators, date, publicationTitle,
 *   conferenceName, publisher, volume, issue, pages, DOI, ISBN, ISSN, url,
 *   abstractNote, language, extra, citationCount }
 * ```
 */

import { abstractToText, decodeEntities } from './html.js';

const USER_AGENT = 'dsh-zotero/0.1 (DeepSeek Harness Zotero bridge)';
const TIMEOUT_MS = 20000;

/** Zotero fields that each supported item type accepts. */
const FIELDS_BY_TYPE = {
  journalArticle: ['title', 'creators', 'date', 'publicationTitle', 'volume', 'issue', 'pages', 'DOI', 'ISSN', 'abstractNote', 'url', 'language', 'extra'],
  conferencePaper: ['title', 'creators', 'date', 'proceedingsTitle', 'conferenceName', 'pages', 'DOI', 'abstractNote', 'url', 'publisher', 'extra'],
  book: ['title', 'creators', 'date', 'publisher', 'place', 'edition', 'ISBN', 'numPages', 'abstractNote', 'url', 'language', 'extra'],
  bookSection: ['title', 'creators', 'date', 'bookTitle', 'publisher', 'place', 'pages', 'edition', 'ISBN', 'abstractNote', 'url', 'extra'],
  preprint: ['title', 'creators', 'date', 'repository', 'archiveID', 'DOI', 'abstractNote', 'url', 'extra'],
  thesis: ['title', 'creators', 'date', 'university', 'place', 'thesisType', 'numPages', 'abstractNote', 'url', 'extra'],
  report: ['title', 'creators', 'date', 'institution', 'reportNumber', 'pages', 'DOI', 'abstractNote', 'url', 'extra'],
  webpage: ['title', 'creators', 'date', 'websiteTitle', 'url', 'abstractNote', 'language', 'extra'],
  document: ['title', 'creators', 'date', 'publisher', 'DOI', 'abstractNote', 'url', 'extra'],
  dataset: ['title', 'creators', 'date', 'publisher', 'DOI', 'abstractNote', 'url', 'extra'],
};

/** Supported item types, in the order tools advertise them. */
export const ITEM_TYPES = Object.keys(FIELDS_BY_TYPE);

/** Error raised when an external provider cannot answer. */
export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ source?: string, status?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProviderError';
    this.source = options.source ?? '';
    this.status = options.status ?? 0;
  }
}

/**
 * Fetch JSON with a timeout, turning HTTP failures into ProviderError.
 * @param {string} url
 * @param {{ source?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<any>}
 */
async function getJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(`${options.source ?? 'provider'} is unreachable: ${error?.message ?? error}`);
  }
  if (response.status === 404) {
    throw new ProviderError(`${options.source ?? 'provider'} has no record for that identifier`, { status: 404 });
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new ProviderError(`${options.source ?? 'provider'} returned ${response.status}: ${body}`, { status: response.status });
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError(`${options.source ?? 'provider'} returned invalid JSON: ${error.message}`);
  }
}

/**
 * Fetch text with a timeout, turning HTTP failures into ProviderError.
 * @param {string} url
 * @param {{ source?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<string>}
 */
async function getText(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8', ...(options.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(`${options.source ?? 'provider'} is unreachable: ${error?.message ?? error}`);
  }
  if (!response.ok) {
    throw new ProviderError(`${options.source ?? 'provider'} returned ${response.status}`, { status: response.status });
  }
  return response.text();
}

/**
 * Normalize a DOI to its bare lower-case form.
 * @param {string} value
 * @returns {string}
 */
export function normalizeDoi(value) {
  return String(value).trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

/**
 * Detect what a user-supplied identifier string is.
 * @param {string} text
 * @returns {{ kind: 'doi'|'arxiv'|'pmid'|'isbn'|'url', value: string }|null}
 */
export function detectIdentifier(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const doiInUrl = raw.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/i);
  if (doiInUrl) return { kind: 'doi', value: normalizeDoi(doiInUrl[1]) };
  if (/^10\.\d{4,9}\/\S+$/.test(raw)) return { kind: 'doi', value: normalizeDoi(raw) };
  const arxivAbs = raw.match(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i);
  if (arxivAbs) return { kind: 'arxiv', value: arxivAbs[1] + (arxivAbs[2] ?? '') };
  if (/^arxiv:\s*\S+$/i.test(raw)) return { kind: 'arxiv', value: raw.replace(/^arxiv:\s*/i, '').trim() };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(raw)) return { kind: 'arxiv', value: raw };
  if (/^pmid:\s*\d+$/i.test(raw)) return { kind: 'pmid', value: raw.replace(/^pmid:\s*/i, '') };
  if (/^isbn:\s*[\dXx-]+$/i.test(raw)) return { kind: 'isbn', value: raw.replace(/^isbn:\s*/i, '').replace(/[^0-9Xx]/g, '') };
  if (/^(97[89])?\d{9}[\dXx]$/.test(raw.replace(/[^0-9Xx]/g, ''))) {
    return { kind: 'isbn', value: raw.replace(/[^0-9Xx]/g, '') };
  }
  if (/^https?:\/\//i.test(raw)) return { kind: 'url', value: raw };
  return null;
}

/**
 * Split a comma or newline separated identifier list.
 * @param {string} text
 * @returns {string[]}
 */
export function splitIdentifiers(text) {
  return String(text ?? '')
    .split(/[\n,;]+/)
    .map(part => part.trim())
    .filter(part => part !== '');
}

/**
 * Build a Zotero creator entry from a free-form name.
 * @param {string} name
 * @param {string} [creatorType]
 * @returns {{creatorType: string, name: string}}
 */
function singleFieldCreator(name, creatorType = 'author') {
  return { creatorType, name: String(name).trim() };
}

/**
 * Build a Zotero creator entry from given and family names.
 * @param {string} given
 * @param {string} family
 * @returns {{creatorType: string, firstName: string, lastName: string}}
 */
function twoFieldCreator(given, family) {
  return { creatorType: 'author', firstName: String(given ?? '').trim(), lastName: String(family ?? '').trim() };
}

/**
 * Convert Crossref's date-parts structure into an ISO-ish date.
 * @param {any} issued
 * @returns {string}
 */
function crossrefDate(issued) {
  const parts = issued?.['date-parts']?.[0];
  if (!Array.isArray(parts) || !Number.isInteger(parts[0])) return '';
  const [year, month, day] = parts;
  if (Number.isInteger(day)) return `${year}-${String(month ?? 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (Number.isInteger(month)) return `${year}-${String(month).padStart(2, '0')}`;
  return String(year);
}

/**
 * Map a Crossref type onto a Zotero item type.
 * @param {string} type
 * @returns {string}
 */
function crossrefItemType(type) {
  switch (type) {
    case 'journal-article': return 'journalArticle';
    case 'proceedings-article': return 'conferencePaper';
    case 'book': return 'book';
    case 'book-chapter': return 'bookSection';
    case 'posted-content': return 'preprint';
    case 'dissertation': return 'thesis';
    case 'report': return 'report';
    case 'dataset': return 'dataset';
    default: return 'journalArticle';
  }
}

/**
 * Convert one Crossref work record into a candidate.
 * @param {any} work
 * @returns {any}
 */
function fromCrossref(work) {
  const creators = (Array.isArray(work.author) ? work.author : [])
    .map(author => (author.family ? twoFieldCreator(author.given, author.family) : String(author.name ?? '') !== '' ? singleFieldCreator(author.name) : null))
    .filter(Boolean);
  const container = Array.isArray(work['container-title']) ? work['container-title'][0] ?? '' : work['container-title'] ?? '';
  const itemType = crossrefItemType(work.type);
  return {
    source: 'crossref',
    sourceId: normalizeDoi(work.DOI ?? ''),
    itemType,
    title: Array.isArray(work.title) ? work.title[0] ?? '' : work.title ?? '',
    creators,
    date: crossrefDate(work.issued),
    publicationTitle: itemType === 'journalArticle' ? container : '',
    conferenceName: itemType === 'conferencePaper' ? container : '',
    proceedingsTitle: itemType === 'conferencePaper' ? container : '',
    bookTitle: itemType === 'bookSection' ? container : '',
    publisher: work.publisher ?? '',
    volume: work.volume ?? '',
    issue: work.issue ?? '',
    pages: work.page ?? '',
    DOI: normalizeDoi(work.DOI ?? ''),
    ISBN: Array.isArray(work.ISBN) ? work.ISBN[0] ?? '' : work.ISBN ?? '',
    ISSN: Array.isArray(work.ISSN) ? work.ISSN[0] ?? '' : work.ISSN ?? '',
    url: work.URL ?? '',
    abstractNote: work.abstract ? abstractToText(work.abstract) : '',
    language: work.language ?? '',
    extra: '',
    citationCount: Number(work['is-referenced-by-count']) || 0,
  };
}

/**
 * Rebuild an abstract from OpenAlex's inverted index.
 * @param {any} index
 * @returns {string}
 */
function openalexAbstract(index) {
  if (index === null || typeof index !== 'object') return '';
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) words[position] = word;
  }
  return words.filter(word => typeof word === 'string').join(' ');
}

/**
 * Split an OpenAlex author display name into given and family parts.
 * @param {string} displayName
 * @returns {string[]}
 */
function splitDisplayName(displayName) {
  const name = String(displayName ?? '').trim();
  if (name === '') return [];
  const words = name.split(/\s+/);
  if (words.length === 1) return [name];
  return [words.slice(0, -1).join(' '), words[words.length - 1]];
}

/**
 * Convert one OpenAlex work record into a candidate.
 * @param {any} work
 * @returns {any}
 */
function fromOpenalex(work) {
  const creators = (Array.isArray(work.authorships) ? work.authorships : [])
    .map(authorship => {
      const display = authorship?.author?.display_name ?? '';
      if (display === '') return null;
      const index = display.indexOf(',');
      if (index > 0) return twoFieldCreator(display.slice(index + 1), display.slice(0, index));
      const [given, family] = splitDisplayName(display);
      if (family === undefined) return singleFieldCreator(display);
      return twoFieldCreator(given, family);
    })
    .filter(Boolean);
  const doi = normalizeDoi(work.doi ?? '');
  const venue = work.primary_location?.source?.display_name ?? '';
  const sourceType = work.primary_location?.source?.type ?? '';
  const itemType = sourceType === 'repository' ? 'preprint' : 'journalArticle';
  return {
    source: 'openalex',
    sourceId: doi !== '' ? `doi:${doi}` : String(work.id ?? '').replace('https://openalex.org/', ''),
    openalexId: String(work.id ?? '').replace('https://openalex.org/', ''),
    itemType,
    title: work.title ?? work.display_name ?? '',
    creators,
    date: work.publication_date ?? (work.publication_year ? String(work.publication_year) : ''),
    publicationTitle: venue,
    publisher: work.primary_location?.source?.host_organization_name ?? '',
    volume: work.biblio?.volume ?? '',
    issue: work.biblio?.issue ?? '',
    pages: [work.biblio?.first_page, work.biblio?.last_page].filter(Boolean).join('-'),
    DOI: doi,
    ISBN: '',
    ISSN: work.primary_location?.source?.issn_l ?? '',
    url: work.doi ? `https://doi.org/${doi}` : work.id ?? '',
    abstractNote: openalexAbstract(work.abstract_inverted_index),
    language: work.language ?? '',
    extra: '',
    citationCount: Number(work.cited_by_count) || 0,
  };
}

/**
 * Strip an arXiv id from an abs URL or versioned id.
 * @param {string} value
 * @returns {string}
 */
function bareArxivId(value) {
  return String(value ?? '')
    .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/i, '')
    .trim();
}

/**
 * Read one field from an Atom entry.
 * @param {string} entry
 * @param {string} tag
 * @returns {string}
 */
function atomField(entry, tag) {
  const match = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeEntities(match[1].replace(/\s+/g, ' ').trim()) : '';
}

/**
 * Convert the arXiv Atom feed into candidates.
 * @param {string} xml
 * @returns {any[]}
 */
function fromArxivFeed(xml) {
  const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(match => match[1]);
  return entries.map(entry => {
    const id = bareArxivId(atomField(entry, 'id'));
    const creators = [...entry.matchAll(/<author>([\s\S]*?)<\/author>/gi)]
      .map(match => atomField(match[1], 'name'))
      .filter(name => name !== '')
      .map(name => singleFieldCreator(name));
    const doi = atomField(entry, 'arxiv:doi');
    const journalRef = atomField(entry, 'arxiv:journal_ref');
    const published = atomField(entry, 'published');
    return {
      source: 'arxiv',
      sourceId: id,
      itemType: 'preprint',
      title: atomField(entry, 'title'),
      creators,
      date: published.slice(0, 10),
      publicationTitle: '',
      repository: 'arXiv',
      archiveID: `arXiv:${id}`,
      DOI: doi,
      url: `https://arxiv.org/abs/${id}`,
      abstractNote: atomField(entry, 'summary'),
      extra: journalRef ? `arXiv journal reference: ${journalRef}` : '',
      citationCount: 0,
    };
  }).filter(candidate => candidate.title !== '');
}

/**
 * Look up a DOI in Crossref.
 * @param {string} doi
 * @returns {Promise<any>}
 */
export async function fetchDoi(doi) {
  const normalized = normalizeDoi(doi);
  const payload = await getJson(`https://api.crossref.org/works/${encodeURIComponent(normalized)}`, { source: 'Crossref' });
  if (!payload?.message) throw new ProviderError(`Crossref has no record for DOI ${normalized}`, { source: 'Crossref' });
  return fromCrossref(payload.message);
}

/**
 * Look up a DOI in OpenAlex, which indexes preprints Crossref does not carry.
 * @param {string} doi
 * @returns {Promise<any>}
 */
export async function fetchOpenalexDoi(doi) {
  const path = encodeURIComponent(`https://doi.org/${normalizeDoi(doi)}`);
  const work = await getJson(`https://api.openalex.org/works/${path}`, { source: 'OpenAlex' });
  const candidate = fromOpenalex(work ?? {});
  if (candidate.title === '') throw new ProviderError(`OpenAlex has no record for ${doi}`, { source: 'OpenAlex' });
  return candidate;
}

/**
 * Look up an arXiv id.
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function fetchArxiv(id) {
  const bare = bareArxivId(id);
  const xml = await getText(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}`, { source: 'arXiv' });
  const [candidate] = fromArxivFeed(xml);
  if (!candidate) throw new ProviderError(`arXiv has no record for ${bare}`, { source: 'arXiv' });
  return candidate;
}

/**
 * Look up a PubMed id through NCBI eutils.
 * @param {string} pmid
 * @returns {Promise<any>}
 */
export async function fetchPmid(pmid) {
  const id = String(pmid).trim();
  const payload = await getJson(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${encodeURIComponent(id)}`,
    { source: 'PubMed' },
  );
  const record = payload?.result?.[id];
  if (!record) throw new ProviderError(`PubMed has no record for PMID ${id}`, { source: 'PubMed' });
  const creators = (Array.isArray(record.authors) ? record.authors : [])
    .map(author => String(author?.name ?? '').trim())
    .filter(name => name !== '')
    .map(name => singleFieldCreator(name));
  const doiEntry = (Array.isArray(record.articleids) ? record.articleids : []).find(entry => entry?.idtype === 'doi');
  return {
    source: 'pubmed',
    sourceId: id,
    itemType: 'journalArticle',
    title: String(record.title ?? '').replace(/\.$/, ''),
    creators,
    date: record.pubdate ?? '',
    publicationTitle: record.source ?? '',
    volume: record.volume ?? '',
    issue: record.issue ?? '',
    pages: record.pages ?? '',
    DOI: normalizeDoi(doiEntry?.value ?? ''),
    url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    abstractNote: '',
    extra: '',
    citationCount: 0,
  };
}

/**
 * Look up an ISBN through OpenLibrary.
 * @param {string} isbn
 * @returns {Promise<any>}
 */
export async function fetchIsbn(isbn) {
  const clean = String(isbn).replace(/[^0-9Xx]/g, '');
  const payload = await getJson(`https://openlibrary.org/isbn/${encodeURIComponent(clean)}.json`, { source: 'OpenLibrary' });
  if (!payload?.title) throw new ProviderError(`OpenLibrary has no record for ISBN ${clean}`, { source: 'OpenLibrary' });
  const authorKeys = Array.isArray(payload.authors) ? payload.authors.map(author => author?.key).filter(Boolean).slice(0, 8) : [];
  const names = [];
  for (const key of authorKeys) {
    try {
      const author = await getJson(`https://openlibrary.org${key}.json`, { source: 'OpenLibrary' });
      if (typeof author?.name === 'string' && author.name !== '') names.push(author.name);
    } catch {
      // A missing author record only costs one name, so keep the book data.
    }
  }
  return {
    source: 'isbn',
    sourceId: clean,
    itemType: 'book',
    title: payload.title,
    creators: names.map(name => singleFieldCreator(name)),
    date: String(payload.publish_date ?? ''),
    publisher: Array.isArray(payload.publishers) ? payload.publishers.join('; ') : payload.publishers ?? '',
    place: Array.isArray(payload.publish_places) ? payload.publish_places.join('; ') : '',
    ISBN: clean,
    numPages: payload.number_of_pages ? String(payload.number_of_pages) : '',
    url: `https://openlibrary.org/isbn/${clean}`,
    abstractNote: typeof payload.description === 'string' ? payload.description : payload.description?.value ?? '',
    extra: '',
    citationCount: 0,
  };
}

/**
 * Read Highwire/citation meta tags from a page.
 * @param {string} html
 * @returns {Map<string, string[]>}
 */
function citationMeta(html) {
  const meta = new Map();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*["']([\s\S]*?)["']/i)?.[1];
    if (!key || content === undefined) continue;
    const value = decodeEntities(content).trim();
    if (value === '') continue;
    const list = meta.get(key) ?? [];
    list.push(value);
    meta.set(key, list);
  }
  return meta;
}

/**
 * Look up a web page's citation metadata.
 * @param {string} url
 * @returns {Promise<any>}
 */
export async function fetchUrl(url) {
  const html = await getText(url, { source: 'the web page' });
  const meta = citationMeta(html);
  const first = key => meta.get(key)?.[0] ?? '';
  const title = first('citation_title') || first('og:title') || first('dc.title')
    || decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  if (title === '') throw new ProviderError('the page exposes no title or citation metadata', { source: 'URL' });
  const authors = [...(meta.get('citation_author') ?? []), ...(meta.get('dc.creator') ?? [])];
  const doi = normalizeDoi(first('citation_doi'));
  const isArticle = first('citation_journal_title') !== '' || first('citation_conference_title') !== '';
  return {
    source: 'url',
    sourceId: url,
    itemType: isArticle ? 'journalArticle' : 'webpage',
    title,
    creators: authors.map(name => singleFieldCreator(name)),
    date: first('citation_publication_date') || first('citation_date') || first('dc.date') || '',
    publicationTitle: first('citation_journal_title'),
    conferenceName: first('citation_conference_title'),
    volume: first('citation_volume'),
    issue: first('citation_issue'),
    pages: first('citation_firstpage') !== ''
      ? [first('citation_firstpage'), first('citation_lastpage')].filter(Boolean).join('-')
      : '',
    DOI: doi,
    url,
    websiteTitle: first('og:site_name'),
    abstractNote: first('citation_abstract') || first('og:description') || first('description'),
    extra: '',
    citationCount: 0,
  };
}

/**
 * Resolve one identifier or URL into a candidate.
 * @param {string} text
 * @returns {Promise<any>}
 */
export async function resolveIdentifier(text) {
  const detected = detectIdentifier(text);
  if (!detected) {
    throw new ProviderError(`"${String(text).slice(0, 80)}" is not a DOI, arXiv id, PMID, ISBN or URL`);
  }
  switch (detected.kind) {
    case 'doi': {
      const arxivDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(detected.value);
      if (arxivDoi) {
        try {
          return await fetchArxiv(arxivDoi[1]);
        } catch {
          // Fall back to Crossref/OpenAlex below; the arXiv API may be rate limited.
        }
      }
      try {
        return await fetchDoi(detected.value);
      } catch (error) {
        const work = await fetchOpenalexDoi(detected.value).catch(() => undefined);
        if (work !== undefined) return work;
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(`no record for ${detected.value} in Crossref or OpenAlex`);
      }
    }
    case 'arxiv': return fetchArxiv(detected.value);
    case 'pmid': return fetchPmid(detected.value);
    case 'isbn': return fetchIsbn(detected.value);
    case 'url': return fetchUrl(detected.value);
    default: throw new ProviderError(`Unsupported identifier kind ${detected.kind}`);
  }
}

/**
 * Search Crossref by free text.
 * @param {string} query
 * @param {{ limit?: number, fromYear?: number }} [options]
 * @returns {Promise<any[]>}
 */
export async function searchCrossref(query, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(limit),
    select: 'DOI,title,author,issued,container-title,volume,issue,page,abstract,type,ISSN,ISBN,publisher,URL',
  });
  if (options.fromYear) params.set('filter', `from-pub-date:${options.fromYear}-01-01`);
  const payload = await getJson(`https://api.crossref.org/works?${params}`, { source: 'Crossref' });
  const items = Array.isArray(payload?.message?.items) ? payload.message.items : [];
  return items.map(fromCrossref).filter(candidate => candidate.title !== '');
}

/**
 * Search OpenAlex by free text.
 * @param {string} query
 * @param {{ limit?: number, fromYear?: number, sort?: 'relevance'|'citations' }} [options]
 * @returns {Promise<any[]>}
 */
export async function searchOpenalex(query, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const params = new URLSearchParams({
    search: query,
    'per-page': String(limit),
    sort: options.sort === 'citations' ? 'cited_by_count:desc' : 'relevance_score:desc',
  });
  if (options.fromYear) params.set('filter', `from_publication_date:${options.fromYear}-01-01`);
  const payload = await getJson(`https://api.openalex.org/works?${params}`, { source: 'OpenAlex' });
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map(fromOpenalex).filter(candidate => candidate.title !== '');
}

/**
 * Search arXiv by free text.
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<any[]>}
 */
export async function searchArxiv(query, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    start: '0',
    max_results: String(limit),
    sortBy: 'relevance',
    sortOrder: 'descending',
  });
  const xml = await getText(`http://export.arxiv.org/api/query?${params}`, { source: 'arXiv' });
  return fromArxivFeed(xml);
}

/**
 * List works OpenAlex links to a seed work.
 * @param {string} doiOrId DOI, OpenAlex id, or `W...` id.
 * @param {{ limit?: number }} [options]
 * @returns {Promise<any[]>}
 */
export async function relatedOpenalex(doiOrId, options = {}) {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const key = String(doiOrId).trim();
  const path = /^W\d+$/.test(key)
    ? key
    : /^10\./.test(key) ? `doi:${normalizeDoi(key)}` : key;
  const work = await getJson(`https://api.openalex.org/works/${encodeURIComponent(path)}?select=id,related_works`, { source: 'OpenAlex' });
  const related = Array.isArray(work?.related_works) ? work.related_works.slice(0, limit) : [];
  const ids = related.map(id => String(id).replace('https://openalex.org/', ''));
  if (ids.length === 0) return [];
  const payload = await getJson(
    `https://api.openalex.org/works?filter=openalex_id:${ids.join('|')}&per-page=${ids.length}`,
    { source: 'OpenAlex' },
  );
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.map(fromOpenalex);
}

/**
 * Search every provider and merge the results, de-duplicating by DOI or title.
 * @param {string} query
 * @param {{ limit?: number, fromYear?: number, sources?: string[], sort?: 'relevance'|'citations' }} [options]
 * @returns {Promise<{ candidates: any[], errors: string[] }>}
 */
export async function searchAll(query, options = {}) {
  const sources = options.sources && options.sources.length ? options.sources : ['openalex', 'crossref', 'arxiv'];
  const perSource = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const errors = [];
  const batches = await Promise.all(sources.map(async source => {
    try {
      if (source === 'openalex') return await searchOpenalex(query, { limit: perSource, fromYear: options.fromYear, sort: options.sort });
      if (source === 'crossref') return await searchCrossref(query, { limit: perSource, fromYear: options.fromYear });
      if (source === 'arxiv') return await searchArxiv(query, { limit: perSource });
      errors.push(`unknown source "${source}"`);
      return [];
    } catch (error) {
      errors.push(`${source}: ${error?.message ?? error}`);
      return [];
    }
  }));
  const seenDoi = new Set();
  const seenTitle = new Set();
  const merged = [];
  for (const candidate of batches.flat()) {
    const titlePrint = String(candidate.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (candidate.DOI !== '' && seenDoi.has(`doi:${candidate.DOI}`)) continue;
    if (titlePrint !== '' && seenTitle.has(titlePrint)) continue;
    if (candidate.DOI !== '') seenDoi.add(`doi:${candidate.DOI}`);
    if (titlePrint !== '') seenTitle.add(titlePrint);
    merged.push(candidate);
  }
  return { candidates: merged, errors };
}

/**
 * Convert a candidate into the JSON body Zotero's local API accepts.
 * @param {any} candidate
 * @param {{ itemType?: string, collections?: string[], tags?: string[], extra?: string }} [options]
 * @returns {Record<string, unknown>}
 */
export function toZoteroItem(candidate, options = {}) {
  const itemType = options.itemType && FIELDS_BY_TYPE[options.itemType] ? options.itemType : candidate.itemType ?? 'journalArticle';
  const fields = FIELDS_BY_TYPE[itemType] ?? FIELDS_BY_TYPE.document;
  const allowed = new Set(fields);
  const item = { itemType };
  for (const field of fields) {
    if (field === 'creators') {
      if (Array.isArray(candidate.creators) && candidate.creators.length) item.creators = candidate.creators;
      continue;
    }
    const value = candidate[field];
    if (typeof value === 'string' && value.trim() !== '') item[field] = value.trim();
  }
  if (item.itemType === 'preprint' && item.repository === undefined) item.repository = 'arXiv';
  const collections = (options.collections ?? []).filter(key => typeof key === 'string' && key !== '');
  if (collections.length) item.collections = collections;
  const tags = (options.tags ?? []).filter(tag => typeof tag === 'string' && tag !== '');
  if (tags.length) item.tags = tags.map(tag => ({ tag }));
  const extra = [item.extra, options.extra].filter(value => typeof value === 'string' && value.trim() !== '').join('\n');
  if (extra !== '') item.extra = extra;
  if (allowed.has('url') === false && typeof candidate.url === 'string' && candidate.url !== '') {
    item.extra = [item.extra, `URL: ${candidate.url}`].filter(Boolean).join('\n');
  }
  return item;
}

/**
 * One-line description of a candidate for search result listings.
 * @param {any} candidate
 * @param {number} index - 1-based position.
 * @returns {string}
 */
export function candidateLine(candidate, index) {
  const authors = Array.isArray(candidate.creators)
    ? candidate.creators.map(creator => creator.lastName || creator.name || '').filter(Boolean)
    : [];
  const parts = [`${index}. [${candidate.source}] ${candidate.title}`];
  if (candidate.date) parts.push(`(${String(candidate.date).slice(0, 4)})`);
  if (authors.length) parts.push(authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''));
  if (candidate.publicationTitle) parts.push(`· ${candidate.publicationTitle}`);
  if (candidate.DOI) parts.push(`· doi:${candidate.DOI}`);
  else if (candidate.sourceId) parts.push(`· ${candidate.sourceId}`);
  if (candidate.citationCount) parts.push(`· cited ${candidate.citationCount}`);
  return parts.join(' ');
}