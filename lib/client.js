/**
 * Client for the local Zotero HTTP API.
 *
 * Zotero 7+ serves a Web-API-v3 compatible interface on 127.0.0.1:23119 when the
 * user enables "Allow other applications on this computer to communicate with
 * Zotero" in the Advanced preferences. Reads need no credentials; every write
 * needs the `Zotero-Server-ID` header and an API key issued by
 * `POST /api/local/authorize` (Zotero shows a confirmation dialog for that).
 */

import { join } from 'node:path';

import { dataDirectory, readJsonFile, writeJsonAtomic } from './paths.js';

/** Default origin of the Zotero local server. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:23119/api';

/** Zotero rejects write batches larger than this. */
export const MAX_WRITE_OBJECTS = 50;

/** Application name shown in the Zotero authorization dialog. */
export const APP_NAME = 'DeepSeek Harness (dsh-zotero)';

const DEFAULT_TIMEOUT_MS = 20000;
const AUTH_FILE_NAME = 'auth.json';

const LOCAL_API_HINT =
  'Enable it in Zotero: Settings -> Advanced -> "Allow other applications on this '
  + 'computer to communicate with Zotero". 中文：设置 → 高级 → 勾选「允许本计算机上的其他'
  + '应用程序与 Zotero 通信」。';

const SERVER_HINT =
  'Start Zotero and retry. The bridge talks to http://127.0.0.1:23119 only.';

/**
 * Error raised for any failed Zotero interaction, carrying an actionable hint.
 */
export class ZoteroError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, hint?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ZoteroError';
    this.status = options.status ?? 0;
    this.hint = options.hint ?? '';
  }

  /** Message including the hint, suitable for showing to the user. */
  get display() {
    return this.hint ? `${this.message}\nhint: ${this.hint}` : this.message;
  }
}

/**
 * Map an HTTP failure from Zotero onto a ZoteroError with a fix-it hint.
 * @param {number} status
 * @param {string} text
 * @returns {ZoteroError}
 */
function httpError(status, text) {
  const detail = (text || '').trim();
  const suffix = detail ? `: ${detail.slice(0, 400)}` : '';
  if (status === 401) {
    return new ZoteroError(`Zotero refused write access (401)${suffix}`, {
      status,
      hint: 'Approve the authorization dialog Zotero shows, then retry. If it never '
        + 'appeared, check the local API is enabled and retry.',
    });
  }
  if (status === 403 && /Local API is not enabled/i.test(detail)) {
    return new ZoteroError('Zotero Local API is disabled (403)', { status, hint: LOCAL_API_HINT });
  }
  if (status === 403) {
    return new ZoteroError(`Zotero denied the request (403)${suffix}`, {
      status,
      hint: 'The library may be read-only, or the authorization was declined.',
    });
  }
  if (status === 404) {
    return new ZoteroError(`Not found (404)${suffix}`, { status });
  }
  if (status === 412) {
    return new ZoteroError(`Version conflict (412)${suffix}`, {
      status,
      hint: 'The object changed since it was read. Read it again and retry with the '
        + 'fresh version.',
    });
  }
  if (status === 413) {
    return new ZoteroError(`Too many objects in one request (413)${suffix}`, {
      status,
      hint: `Send at most ${MAX_WRITE_OBJECTS} objects per batch.`,
    });
  }
  if (status === 428) {
    return new ZoteroError(`Zotero requires a precondition (428)${suffix}`, {
      status,
      hint: 'Retry: the bridge re-reads the Zotero server id and library version.',
    });
  }
  if (status === 429) {
    return new ZoteroError(`Zotero is rate limiting requests (429)${suffix}`, {
      status,
      hint: 'Wait a minute before retrying; authorization requests are limited to 5/min.',
    });
  }
  return new ZoteroError(`Zotero request failed (${status})${suffix}`, { status });
}

/**
 * Join a base path with a key segment.
 * @param {string} base
 * @param {string} key
 * @returns {string}
 */
function withKey(base, key) {
  return `${base}/${encodeURIComponent(key)}`;
}

/**
 * Append only the defined values of a query object to a URL.
 * @param {URL} url
 * @param {Record<string, unknown>} query
 */
function applyQuery(url, query) {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(name, value.join(','));
      continue;
    }
    url.searchParams.set(name, value === true ? '1' : String(value));
  }
}

/**
 * Normalize Zotero's MultiWriteResults JSON into flat lists.
 * @param {any} payload
 * @param {number} offset
 * @returns {{ok: {index: number, key: string, item: any}[], unchanged: {index: number, key: string}[], failed: {index: number, key: string, code: string, message: string}[]}}
 */
function flattenWriteResults(payload, offset) {
  const ok = [];
  const unchanged = [];
  const failed = [];
  const written = new Set();
  for (const [index, item] of Object.entries(payload?.successful ?? {})) {
    written.add(String(index));
    ok.push({ index: offset + Number(index), key: item?.key ?? item?.data?.key ?? '', item });
  }
  for (const [index, key] of Object.entries(payload?.success ?? {})) {
    if (written.has(String(index))) continue;
    ok.push({ index: offset + Number(index), key: String(key), item: null });
  }
  for (const [index, key] of Object.entries(payload?.unchanged ?? {})) {
    unchanged.push({ index: offset + Number(index), key: String(key) });
  }
  for (const [index, failure] of Object.entries(payload?.failed ?? {})) {
    failed.push({
      index: offset + Number(index),
      key: failure?.key ?? '',
      code: failure?.code ?? '',
      message: failure?.message ?? 'write failed',
    });
  }
  ok.sort((a, b) => a.index - b.index);
  failed.sort((a, b) => a.index - b.index);
  unchanged.sort((a, b) => a.index - b.index);
  return { ok, unchanged, failed };
}

/**
 * Zotero local API client bound to one user library.
 */
export class ZoteroClient {
  #baseUrl;

  #userId;

  #authFile;

  #timeoutMs;

  #fetch;

  #serverId = '';

  #mediaUrl = '';

  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] API root, e.g. `http://127.0.0.1:23119/api`.
   * @param {number} [options.userId] Library owner id; the local API accepts 0.
   * @param {string} [options.authFile] Where the write API key is cached.
   * @param {number} [options.timeoutMs] Per-request timeout.
   * @param {typeof fetch} [options.fetchImpl] Fetch implementation (tests).
   */
  constructor(options = {}) {
    this.#baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#userId = Number.isInteger(options.userId) ? options.userId : 0;
    this.#authFile = options.authFile || join(dataDirectory(), AUTH_FILE_NAME);
    this.#timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl || globalThis.fetch;
  }

  /** API root used by this client. */
  get baseUrl() {
    return this.#baseUrl;
  }

  /** Cached Zotero-Server-ID, empty until the first successful exchange. */
  get serverId() {
    return this.#serverId;
  }

  /** Base path of the user library, e.g. `/users/0`. */
  get library() {
    return `/users/${this.#userId}`;
  }

  /**
   * Issue one HTTP request and return status, headers and text.
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, unknown>, body?: unknown, headers?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, headers: Headers, text: string }>}
   */
  async request(method, path, options = {}) {
    const url = new URL(`${this.#baseUrl}${path}`);
    applyQuery(url, options.query);
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };
    let payload;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    Object.assign(headers, options.headers ?? {});
    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError'
        ? `Zotero did not answer within ${this.#timeoutMs} ms`
        : `Cannot reach Zotero at ${this.#baseUrl} (${error?.message ?? error})`;
      throw new ZoteroError(reason, { hint: SERVER_HINT });
    }
    const text = await response.text();
    const serverId = response.headers.get('zotero-server-id');
    if (serverId) this.#serverId = serverId;
    const media = response.headers.get('x-zotero-media-url');
    if (media) this.#mediaUrl = media;
    return { status: response.status, headers: response.headers, text };
  }

  /**
   * Read a JSON document.
   * @param {string} path
   * @param {Record<string, unknown>} [query]
   * @returns {Promise<any>}
   */
  async getJson(path, query) {
    const { status, text } = await this.request('GET', path, { query });
    if (status < 200 || status >= 300) throw httpError(status, text);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ZoteroError(`Zotero returned invalid JSON for ${path}: ${error.message}`);
    }
  }

  /**
   * Read a text document (used for export formats such as BibTeX).
   * @param {string} path
   * @param {Record<string, unknown>} [query]
   * @returns {Promise<string>}
   */
  async getText(path, query) {
    const { status, text } = await this.request('GET', path, { query });
    if (status < 200 || status >= 300) throw httpError(status, text);
    return text;
  }

  /**
   * Probe the local API; never throws.
   * @returns {Promise<{ ok: boolean, status: number, serverId: string, apiVersion: string, schemaVersion: string, zoteroVersion: string, error: string }>}
   */
  async probe() {
    try {
      const { status, headers, text } = await this.request('GET', '/');
      return {
        ok: status === 200,
        status,
        serverId: headers.get('zotero-server-id') ?? '',
        apiVersion: headers.get('zotero-api-version') ?? '',
        schemaVersion: headers.get('zotero-schema-version') ?? '',
        zoteroVersion: headers.get('x-zotero-version') ?? '',
        error: status === 200 ? '' : text.trim().slice(0, 300),
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        serverId: '',
        apiVersion: '',
        schemaVersion: '',
        zoteroVersion: '',
        error: error?.message ?? String(error),
      };
    }
  }

  /**
   * Return the Zotero server id, probing the local API once if necessary.
   * @returns {Promise<string>}
   */
  async ensureServerId() {
    if (this.#serverId) return this.#serverId;
    const probe = await this.probe();
    if (!probe.ok) {
      if (probe.status === 403 && /Local API is not enabled/i.test(probe.error)) {
        throw new ZoteroError('Zotero Local API is disabled (403)', { status: 403, hint: LOCAL_API_HINT });
      }
      throw new ZoteroError(probe.error || 'Zotero local API is unavailable', {
        status: probe.status,
        hint: SERVER_HINT,
      });
    }
    if (!probe.serverId) {
      throw new ZoteroError('Zotero did not send a Zotero-Server-ID header', {
        hint: 'Restart Zotero and retry.',
      });
    }
    return probe.serverId;
  }

  /** @returns {Promise<{key: string, remember: boolean, appName?: string, serverId?: string, createdAt?: string}|null>} */
  async readAuth() {
    const auth = await readJsonFile(this.#authFile);
    return auth && typeof auth.key === 'string' && auth.key ? auth : null;
  }

  /** Drop the cached write key. */
  async clearAuth() {
    await writeJsonAtomic(this.#authFile, {});
  }

  /**
   * Ask Zotero for a write API key. Zotero shows a dialog the user must approve.
   * @param {{ appName?: string }} [options]
   * @returns {Promise<string>} The granted key.
   */
  async authorize(options = {}) {
    const serverId = await this.ensureServerId();
    const appName = options.appName || APP_NAME;
    const { status, text } = await this.request('POST', '/local/authorize', {
      headers: { 'Zotero-Server-ID': serverId },
      body: { appName },
    });
    if (status === 403) {
      throw new ZoteroError('Zotero write authorization was declined', {
        status,
        hint: 'Approve the dialog in Zotero to let DSH modify the library. '
          + 'Choose "Always allow" so the key is reused.',
      });
    }
    if (status < 200 || status >= 300) throw httpError(status, text);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ZoteroError(`Zotero returned invalid authorize response: ${error.message}`);
    }
    if (typeof parsed?.key !== 'string' || !parsed.key) {
      throw new ZoteroError('Zotero authorize response carried no key');
    }
    await writeJsonAtomic(this.#authFile, {
      key: parsed.key,
      remember: Boolean(parsed.remember),
      appName,
      serverId,
      createdAt: new Date().toISOString(),
    });
    return parsed.key;
  }

  /**
   * Perform a write request, authorizing (and re-authorizing once) as needed.
   * @param {string} method
   * @param {string} path
   * @param {{ query?: Record<string, unknown>, body?: unknown, version?: number }} [options]
   * @returns {Promise<{ status: number, headers: Headers, text: string }>}
   */
  async write(method, path, options = {}) {
    const serverId = await this.ensureServerId();
    const stored = await this.readAuth();
    let key = stored?.key ?? '';
    if (!key) key = await this.authorize();

    for (let attempt = 0; attempt < 2; attempt++) {
      /** @type {Record<string, string>} */
      const headers = { 'Zotero-Server-ID': serverId, 'Zotero-API-Key': key };
      if (options.version !== undefined && options.version !== null) {
        headers['If-Unmodified-Since-Version'] = String(options.version);
      }
      const result = await this.request(method, path, {
        query: options.query,
        body: options.body,
        headers,
      });
      if (result.status === 401 && attempt === 0) {
        await this.clearAuth();
        key = await this.authorize();
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw httpError(result.status, result.text);
      return result;
    }
    throw new ZoteroError('Zotero write failed after re-authorizing', {
      hint: 'Check that Zotero still has the local API enabled, then retry.',
    });
  }

  /**
   * Current library version (the sync cursor Zotero reports as Last-Modified-Version).
   * @returns {Promise<number>}
   */
  async libraryVersion() {
    const { status, headers, text } = await this.request('GET', `${this.library}/items`, {
      query: { limit: 1, format: 'keys' },
    });
    if (status < 200 || status >= 300) throw httpError(status, text);
    const version = Number.parseInt(headers.get('last-modified-version') ?? '', 10);
    if (!Number.isFinite(version)) {
      throw new ZoteroError('Zotero did not report a library version');
    }
    return version;
  }

  /**
   * Search items in the library.
   * @param {object} [query]
   * @param {string} [query.q] Quick-search text.
   * @param {string} [query.qmode] Quick-search mode; `titleCreatorYear` by default.
   * @param {string} [query.itemType] Item type filter, API search syntax allowed.
   * @param {string} [query.tag] Tag filter, API search syntax allowed.
   * @param {boolean} [query.top] Only top-level items.
   * @param {boolean} [query.trash] Only trashed items.
   * @param {string} [query.collectionKey] Restrict to one collection.
   * @param {string[]} [query.itemKeys] Restrict to specific keys.
   * @param {string} [query.sort] Sort field.
   * @param {'asc'|'desc'} [query.direction] Sort direction.
   * @param {number} [query.limit] Page size.
   * @param {number} [query.start] Page offset.
   * @param {number} [query.since] Only objects changed after this version.
   * @returns {Promise<{ items: any[], total: number, version: number }>}
   */
  async searchItems(query = {}) {
    const base = query.collectionKey
      ? `${this.library}/collections/${encodeURIComponent(query.collectionKey)}/items`
      : `${this.library}/items`;
    const path = query.trash
      ? `${this.library}/items/trash`
      : query.top
        ? `${base}/top`
        : base;
    const { status, headers, text } = await this.request('GET', path, {
      query: {
        q: query.q,
        qmode: query.qmode,
        itemType: query.itemType,
        tag: query.tag,
        collectionKey: query.collectionKey,
        itemKey: query.itemKeys,
        sort: query.sort,
        direction: query.direction,
        limit: query.limit,
        start: query.start,
        since: query.since,
      },
    });
    if (status < 200 || status >= 300) throw httpError(status, text);
    const items = text ? JSON.parse(text) : [];
    return {
      items: Array.isArray(items) ? items : [items],
      total: Number.parseInt(headers.get('total-results') ?? '', 10) || (Array.isArray(items) ? items.length : 1),
      version: Number.parseInt(headers.get('last-modified-version') ?? '', 10) || 0,
    };
  }

  /**
   * Fetch one item.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async getItem(key) {
    return this.getJson(withKey(`${this.library}/items`, key));
  }

  /**
   * Fetch several items by key.
   * @param {string[]} keys
   * @returns {Promise<any[]>}
   */
  async getItems(keys) {
    if (!keys.length) return [];
    const { items } = await this.searchItems({ itemKeys: keys, limit: keys.length });
    return items;
  }

  /**
   * Fetch child items (notes, attachments, annotations) of a top-level item.
   * @param {string} key
   * @param {{ itemType?: string, limit?: number }} [options]
   * @returns {Promise<any[]>}
   */
  async getChildren(key, options = {}) {
    const query = options.itemType ? { itemType: options.itemType } : undefined;
    const children = await this.getJson(withKey(`${this.library}/items`, key).concat('/children'), query);
    if (!Array.isArray(children)) return children ? [children] : [];
    if (!options.itemType) return children;
    return children.filter((child) => child?.data?.itemType === options.itemType);
  }

  /**
   * Extract the indexed full text of an attachment.
   * @param {string} key
   * @returns {Promise<{ content: string, indexedPages: number, totalPages: number, indexedChars: number, totalChars: number }>}
   */
  async getFulltext(key) {
    const data = await this.getJson(withKey(`${this.library}/items`, key).concat('/fulltext'));
    return {
      content: typeof data?.content === 'string' ? data.content : '',
      indexedPages: Number(data?.indexedPages) || 0,
      totalPages: Number(data?.totalPages) || 0,
      indexedChars: Number(data?.indexedChars) || 0,
      totalChars: Number(data?.totalChars) || 0,
    };
  }

  /**
   * List collections.
   * @param {{ top?: boolean }} [options]
   * @returns {Promise<any[]>}
   */
  async listCollections(options = {}) {
    const path = options.top ? `${this.library}/collections/top` : `${this.library}/collections`;
    const data = await this.getJson(path);
    return Array.isArray(data) ? data : [data];
  }

  /**
   * Fetch one collection.
   * @param {string} key
   * @returns {Promise<any>}
   */
  async getCollection(key) {
    return this.getJson(withKey(`${this.library}/collections`, key));
  }

  /**
   * List tags with usage counts.
   * @param {{ limit?: number }} [options]
   * @returns {Promise<any[]>}
   */
  async listTags(options = {}) {
    const data = await this.getJson(`${this.library}/tags`, { limit: options.limit });
    return Array.isArray(data) ? data : [data];
  }

  /**
   * Create or merge-update items. Entries with a `key` must carry `version`.
   * Batches larger than Zotero's limit are split and re-indexed.
   * @param {any[]} items
   * @returns {Promise<{ ok: {index: number, key: string, item: any}[], unchanged: {index: number, key: string}[], failed: {index: number, key: string, code: string, message: string}[] }>}
   */
  async writeItems(items) {
    return this.#writeBatched(`${this.library}/items`, items);
  }

  /**
   * Create or merge-update collections.
   * @param {any[]} collections
   * @returns {Promise<{ ok: {index: number, key: string, item: any}[], unchanged: {index: number, key: string}[], failed: {index: number, key: string, code: string, message: string}[] }>}
   */
  async writeCollections(collections) {
    return this.#writeBatched(`${this.library}/collections`, collections);
  }

  /**
   * @param {string} path
   * @param {any[]} entries
   */
  async #writeBatched(path, entries) {
    const merged = { ok: [], unchanged: [], failed: [] };
    for (let offset = 0; offset < entries.length; offset += MAX_WRITE_OBJECTS) {
      const chunk = entries.slice(offset, offset + MAX_WRITE_OBJECTS);
      const { text } = await this.write('POST', path, { body: chunk });
      const parsed = text ? JSON.parse(text) : {};
      const results = flattenWriteResults(parsed, offset);
      merged.ok.push(...results.ok);
      merged.unchanged.push(...results.unchanged);
      merged.failed.push(...results.failed);
    }
    return merged;
  }

  /**
   * Merge-patch one object (shallow merge: arrays are replaced wholesale).
   * @param {'items'|'collections'} kind
   * @param {string} key
   * @param {Record<string, unknown>} patch
   * @returns {Promise<any>} The updated object as returned by a fresh read.
   */
  async patchObject(kind, key, patch) {
    const path = withKey(`${this.library}/${kind}`, key);
    const current = await this.getJson(path);
    const version = Number(current?.version);
    if (!Number.isFinite(version)) throw new ZoteroError(`Zotero returned no version for ${key}`);
    await this.write('PATCH', path, { body: { ...patch, version } });
    try {
      return await this.getJson(path);
    } catch {
      // A trashed item may no longer be readable by key; report the merge result.
      return { ...current, ...patch, version: version + 1 };
    }
  }

  /**
   * Move items to the trash (reversible) or erase them permanently.
   * @param {string[]} keys
   * @param {{ permanent?: boolean }} [options]
   * @returns {Promise<{ deleted: string[], failed: {key: string, message: string}[] }>}
   */
  async deleteItems(keys, options = {}) {
    const deleted = [];
    const failed = [];
    if (options.permanent) {
      for (let offset = 0; offset < keys.length; offset += MAX_WRITE_OBJECTS) {
        const chunk = keys.slice(offset, offset + MAX_WRITE_OBJECTS);
        const version = await this.libraryVersion();
        try {
          await this.write('DELETE', `${this.library}/items`, {
            query: { itemKey: chunk },
            version,
          });
          deleted.push(...chunk);
        } catch (error) {
          for (const key of chunk) failed.push({ key, message: error?.message ?? String(error) });
        }
      }
      return { deleted, failed };
    }
    for (const key of keys) {
      try {
        await this.patchObject('items', key, { deleted: true });
        deleted.push(key);
      } catch (error) {
        failed.push({ key, message: error?.message ?? String(error) });
      }
    }
    return { deleted, failed };
  }

  /**
   * Permanently delete one collection (its items stay in the library).
   * @param {string} key
   * @returns {Promise<void>}
   */
  async deleteCollection(key) {
    const version = await this.libraryVersion();
    await this.write('DELETE', withKey(`${this.library}/collections`, key), { version });
  }
}

/**
 * Create a client configured for the current profile's cached key file.
 * @param {{ baseUrl?: string }} [options]
 * @returns {ZoteroClient}
 */
export function createClient(options = {}) {
  return new ZoteroClient(options);
}