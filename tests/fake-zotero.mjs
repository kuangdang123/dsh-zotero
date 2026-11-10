/**
 * A small in-process imitation of the Zotero local API.
 *
 * It implements the subset the bridge uses — item/collection/tag reads, the
 * multi-object write protocol, optimistic version checks, the authorization
 * handshake, and the trash flag — so the tools can be tested without a running
 * Zotero. Behavior mirrors the checks in Zotero's `server_localAPI.js`.
 */

import { createServer } from 'node:http';

/** Server id the fake Zotero sends and expects. */
export const SERVER_ID = 'FAKE0000SRV1';

const LIBRARY = { type: 'user', id: 0, name: 'tester' };

/**
 * @param {string} prefix
 * @returns {() => string}
 */
function keyFactory(prefix) {
  let counter = 0;
  return () => `${prefix}${String(++counter).padStart(7, '0')}`.slice(0, 8).toUpperCase();
}

/**
 * Start a fake Zotero local server.
 * @param {{ enabled?: boolean, remember?: boolean }} [options]
 * @returns {Promise<{ origin: string, state: any, close: () => Promise<void> }>}
 */
export async function startFakeZotero(options = {}) {
  const state = {
    enabled: options.enabled !== false,
    remember: options.remember !== false,
    items: new Map(),
    collections: new Map(),
    fulltext: new Map(),
    keys: new Map(),
    authorizeCalls: 0,
    writeCalls: 0,
    version: 10,
    nextItemKey: keyFactory('I'),
    nextCollectionKey: keyFactory('C'),
    nextAuthKey: keyFactory('K'),
  };

  state.bump = () => {
    state.version += 1;
    return state.version;
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '';
      try {
        handle(request, response, body);
      } catch (error) {
        send(response, 500, 'text/plain', String(error?.stack ?? error));
      }
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {string} body
   */
  function handle(request, response, body) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const headers = {
      'Zotero-API-Version': '3',
      'Zotero-Schema-Version': '44',
      'Zotero-Server-ID': SERVER_ID,
      'Total-Results': '0',
      'Last-Modified-Version': String(state.version),
    };
    const method = request.method ?? 'GET';

    if (!state.enabled) {
      send(response, 403, 'text/plain', 'Local API is not enabled', headers);
      return;
    }

    const path = url.pathname;
    if (path === '/api/' || path === '/api') {
      send(response, 200, 'text/plain', 'Nothing to see here.', headers);
      return;
    }
    if (path === '/api/local/authorize') {
      handleAuthorize(request, response, body, headers);
      return;
    }
    if (!path.startsWith('/api/')) {
      send(response, 404, 'text/plain', 'Not found', headers);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      const serverId = request.headers['zotero-server-id'];
      if (!serverId) {
        send(response, 428, 'text/plain', 'Zotero-Server-ID not provided', headers);
        return;
      }
      if (serverId !== SERVER_ID) {
        send(response, 412, 'text/plain', 'Zotero-Server-ID mismatch', headers);
        return;
      }
      const key = request.headers['zotero-api-key']
        ?? url.searchParams.get('key')
        ?? (request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '');
      if (!key) {
        send(response, 401, 'text/plain',
          'API key required -- POST /api/local/authorize to obtain one',
          { ...headers, 'WWW-Authenticate': 'Zotero-API-Key' });
        return;
      }
      const grant = state.keys.get(key);
      if (!grant) {
        send(response, 401, 'text/plain', 'Invalid or expired API key', { ...headers, 'WWW-Authenticate': 'Zotero-API-Key' });
        return;
      }
      state.writeCalls += 1;
      if (!grant.remember) grant.uses += 1;
      if (!grant.remember && grant.uses > 1) {
        state.keys.delete(key);
        send(response, 401, 'text/plain', 'Invalid or expired API key', { ...headers, 'WWW-Authenticate': 'Zotero-API-Key' });
        return;
      }
    }

    const rest = path.slice('/api'.length);
    const query = url.searchParams;
    const parts = rest.split('/').filter(segment => segment !== '');
    if (parts[0] !== 'users' || (parts[1] !== '0' && parts[1] !== String(LIBRARY.id))) {
      send(response, 501, 'text/plain', 'Only the user library is supported', headers);
      return;
    }
    const segments = parts.slice(2);

    if (segments[0] === 'items') routeItems(request, response, method, segments, query, body, headers);
    else if (segments[0] === 'collections') routeCollections(request, response, method, segments, query, body, headers);
    else if (segments[0] === 'tags') routeTags(request, response, method, segments, query, headers);
    else send(response, 404, 'text/plain', 'Not found', headers);
  }

  function handleAuthorize(request, response, body, headers) {
    if (request.method !== 'POST') {
      send(response, 405, 'text/plain', 'Method not allowed', headers);
      return;
    }
    const serverId = request.headers['zotero-server-id'];
    if (!serverId) {
      send(response, 428, 'text/plain', 'Zotero-Server-ID not provided', headers);
      return;
    }
    if (serverId !== SERVER_ID) {
      send(response, 412, 'text/plain', 'Zotero-Server-ID mismatch', headers);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      send(response, 400, 'text/plain', 'Invalid JSON', headers);
      return;
    }
    if (typeof parsed.appName !== 'string' || parsed.appName.trim() === '') {
      send(response, 400, 'text/plain', 'appName not provided', headers);
      return;
    }
    state.authorizeCalls += 1;
    if (state.deny) {
      send(response, 403, 'application/json', JSON.stringify({ denied: true }), headers);
      return;
    }
    const key = state.nextAuthKey();
    state.keys.set(key, { appName: parsed.appName, remember: state.remember, uses: 0 });
    send(response, 200, 'application/json', JSON.stringify({ key, remember: state.remember }), headers);
  }

  function routeItems(request, response, method, segments, query, body, headers) {
    const [, second, third, fourth] = segments;
    if (method === 'GET' && second === undefined) {
      listItems(response, query, headers);
      return;
    }
    if (method === 'GET' && (second === 'trash' || second === 'top')) {
      listItems(response, query, headers, { trash: second === 'trash', top: second === 'top' });
      return;
    }
    if (method === 'GET' && second === 'tags') {
      send(response, 200, 'application/json', JSON.stringify(tagList(query)), headers);
      return;
    }
    if (method === 'GET' && second !== undefined) {
      const item = state.items.get(second);
      if (!item) {
        send(response, 404, 'text/plain', 'Item not found', headers);
        return;
      }
      if (third === 'children') {
        let children = [...state.items.values()].filter(entry => entry.data.parentItem === second);
        const itemType = query.get('itemType');
        if (itemType) {
          const types = itemType.split('||').map(value => value.trim()).filter(Boolean);
          children = children.filter(entry => types.includes(entry.data.itemType));
        } else {
          children = children.filter(entry => entry.data.itemType !== 'annotation');
        }
        send(response, 200, 'application/json', JSON.stringify(children.map(toResponse)), withTotal(headers, children.length));
        return;
      }
      if (third === 'fulltext') {
        const fulltext = state.fulltext.get(second);
        if (!fulltext) {
          send(response, 404, 'text/plain', 'Full-text content is not available for this attachment', headers);
          return;
        }
        send(response, 200, 'application/json', JSON.stringify(fulltext), headers);
        return;
      }
      send(response, 200, 'application/json', JSON.stringify(toResponse(item)), headers);
      return;
    }
    if (method === 'POST') {
      handleItemWrite(response, body, headers);
      return;
    }
    if (method === 'PATCH') {
      handleItemPatch(response, second, body, headers);
      return;
    }
    if (method === 'DELETE' && second !== undefined) {
      handleSingleDelete(response, second, request, headers);
      return;
    }
    if (method === 'DELETE') {
      handleMultiDelete(response, request, query, headers);
      return;
    }
    send(response, 405, 'text/plain', 'Method not allowed', headers);
  }

  function listItems(response, query, headers, overrides = {}) {
    const format = query.get('format') ?? 'json';
    const trash = overrides.trash ?? query.get('trash') === '1';
    const top = overrides.top ?? false;
    const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
    const start = query.get('start') ? Number(query.get('start')) : 0;
    const itemKeys = query.get('itemKey')?.split(',').filter(Boolean) ?? [];
    const q = query.get('q') ?? '';
    const qmode = query.get('qmode') ?? 'titleCreatorYear';
    const itemType = query.get('itemType') ?? '';
    const tag = query.get('tag') ?? '';

    let items = [...state.items.values()];
    if (overrides.collectionKey) items = items.filter(item => (item.data.collections ?? []).includes(overrides.collectionKey));
    items = items.filter(item => Boolean(item.data.deleted) === Boolean(trash));
    if (top) items = items.filter(item => !item.data.parentItem);
    if (itemKeys.length > 0) items = items.filter(item => itemKeys.includes(item.key));
    if (itemType) items = items.filter(item => item.data.itemType === itemType);
    if (tag) items = items.filter(item => (item.data.tags ?? []).some(entry => entry.tag === tag));
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter(item => {
        const data = item.data;
        const fields = qmode === 'everything'
          ? [data.title, data.abstractNote, data.publicationTitle, data.DOI, data.note, data.annotationText, data.annotationComment]
          : [data.title, data.date];
        const creators = (data.creators ?? []).flatMap(creator => [creator.firstName, creator.lastName, creator.name]);
        return [...fields, ...creators].some(value => String(value ?? '').toLowerCase().includes(needle));
      });
    }
    const sort = query.get('sort');
    if (sort === 'title') items.sort((left, right) => String(left.data.title ?? '').localeCompare(String(right.data.title ?? '')));
    else if (sort === 'dateModified' || !sort) items.sort((left, right) => right.version - left.version);
    else if (sort === 'dateAdded') items.sort((left, right) => right.key.localeCompare(left.key));
    if (query.get('direction') === 'asc') items.reverse();

    const total = items.length;
    const page = items.slice(start, limit === undefined ? undefined : start + limit);
    const withHeaders = withTotal(headers, total);
    if (format === 'keys') {
      send(response, 200, 'application/json', JSON.stringify(page.map(item => item.key)), withHeaders);
      return;
    }
    send(response, 200, 'application/json', JSON.stringify(page.map(toResponse)), withHeaders);
  }

  function handleItemWrite(response, body, headers) {
    let entries;
    try {
      entries = JSON.parse(body || '[]');
    } catch {
      send(response, 400, 'text/plain', 'Invalid JSON', headers);
      return;
    }
    if (!Array.isArray(entries)) {
      send(response, 400, 'text/plain', 'Uploaded data must be a JSON array', headers);
      return;
    }
    if (entries.length > 50) {
      send(response, 413, 'text/plain', 'Cannot add more than 50 items at a time', headers);
      return;
    }
    const payload = { successful: {}, success: {}, unchanged: {}, failed: {} };
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        payload.failed[index] = { key: '', code: 400, message: 'Entry must be an object' };
        return;
      }
      const existing = entry.key ? state.items.get(entry.key) : undefined;
      if (entry.key && existing === undefined && Number(entry.version) > 0) {
        payload.failed[index] = { key: entry.key, code: 404, message: 'Object not found' };
        return;
      }
      if (existing && Number(entry.version) !== existing.version) {
        payload.failed[index] = { key: entry.key, code: 412, message: 'Version conflict' };
        return;
      }
      if (!existing && typeof entry.itemType !== 'string') {
        payload.failed[index] = { key: '', code: 400, message: 'itemType property not provided' };
        return;
      }
      const key = existing?.key ?? state.nextItemKey();
      const data = existing ? { ...existing.data, ...stripMeta(entry) } : { ...stripMeta(entry) };
      if (data.deleted === undefined && !existing) delete data.deleted;
      const item = { key, version: state.bump(), data };
      state.items.set(key, item);
      payload.success[index] = key;
      payload.successful[index] = toResponse(item);
    });
    send(response, 200, 'application/json', JSON.stringify(payload), headers);
  }

  function handleItemPatch(response, key, body, headers) {
    const item = key ? state.items.get(key) : undefined;
    if (!item) {
      send(response, 404, 'text/plain', 'Item not found', headers);
      return;
    }
    let patch;
    try {
      patch = JSON.parse(body || '{}');
    } catch {
      send(response, 400, 'text/plain', 'Invalid JSON', headers);
      return;
    }
    if (patch.version === undefined) {
      send(response, 428, 'text/plain', 'Version not provided', headers);
      return;
    }
    if (Number(patch.version) !== item.version) {
      send(response, 412, 'text/plain', 'Version conflict', headers);
      return;
    }
    const data = { ...item.data, ...stripMeta(patch) };
    if (data.deleted === false) delete data.deleted;
    item.data = data;
    item.version = state.bump();
    send(response, 204, 'text/plain', '', headers);
  }

  function handleSingleDelete(response, key, request, headers) {
    const expected = request.headers['if-unmodified-since-version'];
    if (!expected) {
      send(response, 428, 'text/plain', 'If-Unmodified-Since-Version not provided', headers);
      return;
    }
    const item = state.items.get(key);
    if (!item) {
      send(response, 404, 'text/plain', 'Item not found', headers);
      return;
    }
    if (item.version > Number(expected)) {
      send(response, 412, 'text/plain', 'Version conflict', headers);
      return;
    }
    state.items.delete(key);
    state.bump();
    send(response, 204, 'text/plain', '', headers);
  }

  function handleMultiDelete(response, request, query, headers) {
    const expected = request.headers['if-unmodified-since-version'];
    if (!expected) {
      send(response, 428, 'text/plain', 'If-Unmodified-Since-Version not provided', headers);
      return;
    }
    if (state.version > Number(expected)) {
      send(response, 412, 'text/plain', 'Version conflict', headers);
      return;
    }
    const keys = query.get('itemKey')?.split(',').filter(Boolean) ?? [];
    if (keys.length === 0) {
      send(response, 400, 'text/plain', 'No itemKey provided', headers);
      return;
    }
    for (const key of keys) state.items.delete(key);
    state.bump();
    send(response, 204, 'text/plain', '', headers);
  }

  function routeCollections(request, response, method, segments, query, body, headers) {
    const [, second] = segments;
    if (method === 'GET' && second === undefined) {
      const list = [...state.collections.values()];
      send(response, 200, 'application/json', JSON.stringify(list.map(toCollectionResponse)), withTotal(headers, list.length));
      return;
    }
    if (method === 'GET' && second === 'top') {
      const list = [...state.collections.values()].filter(collection => !collection.data.parentCollection);
      send(response, 200, 'application/json', JSON.stringify(list.map(toCollectionResponse)), withTotal(headers, list.length));
      return;
    }
    if (method === 'GET' && segments[2] === 'items') {
      listItems(response, query, headers, {
        collectionKey: second,
        top: segments[3] === 'top',
        trash: segments[3] === 'trash',
      });
      return;
    }
    if (method === 'GET' && second !== undefined) {
      const collection = state.collections.get(second);
      if (!collection) {
        send(response, 404, 'text/plain', 'Collection not found', headers);
        return;
      }
      send(response, 200, 'application/json', JSON.stringify(toCollectionResponse(collection)), headers);
      return;
    }
    if (method === 'POST') {
      let entries;
      try {
        entries = JSON.parse(body || '[]');
      } catch {
        send(response, 400, 'text/plain', 'Invalid JSON', headers);
        return;
      }
      const payload = { successful: {}, success: {}, unchanged: {}, failed: {} };
      entries.forEach((entry, index) => {
        if (!entry || typeof entry.name !== 'string' || entry.name.trim() === '') {
          payload.failed[index] = { key: '', code: 400, message: 'Collection name cannot be empty' };
          return;
        }
        const key = entry.key ?? state.nextCollectionKey();
        const collection = { key, version: state.bump(), data: { name: entry.name, parentCollection: entry.parentCollection ?? false } };
        state.collections.set(key, collection);
        payload.success[index] = key;
        payload.successful[index] = toCollectionResponse(collection);
      });
      send(response, 200, 'application/json', JSON.stringify(payload), headers);
      return;
    }
    if (method === 'PATCH' && second !== undefined) {
      const collection = state.collections.get(second);
      if (!collection) {
        send(response, 404, 'text/plain', 'Collection not found', headers);
        return;
      }
      const patch = JSON.parse(body || '{}');
      if (patch.version === undefined) {
        send(response, 428, 'text/plain', 'Version not provided', headers);
        return;
      }
      if (Number(patch.version) !== collection.version) {
        send(response, 412, 'text/plain', 'Version conflict', headers);
        return;
      }
      collection.data = { ...collection.data, ...patch };
      delete collection.data.version;
      collection.version = state.bump();
      send(response, 204, 'text/plain', '', headers);
      return;
    }
    if (method === 'DELETE' && second !== undefined) {
      const expected = request.headers['if-unmodified-since-version'];
      if (!expected) {
        send(response, 428, 'text/plain', 'If-Unmodified-Since-Version not provided', headers);
        return;
      }
      state.collections.delete(second);
      state.bump();
      send(response, 204, 'text/plain', '', headers);
      return;
    }
    send(response, 405, 'text/plain', 'Method not allowed', headers);
  }

  function routeTags(request, response, method, segments, query, headers) {
    if (method === 'GET') {
      send(response, 200, 'application/json', JSON.stringify(tagList(query)), withTotal(headers, tagList(query).length));
      return;
    }
    send(response, 405, 'text/plain', 'Method not allowed', headers);
  }

  function tagList(query) {
    const counts = new Map();
    for (const item of state.items.values()) {
      for (const entry of item.data.tags ?? []) counts.set(entry.tag, (counts.get(entry.tag) ?? 0) + 1);
    }
    const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
    return [...counts.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, limit === undefined ? undefined : limit)
      .map(([tag, numItems]) => ({ tag, links: {}, meta: { type: 'tag', numItems } }));
  }

  function toResponse(item) {
    return {
      key: item.key,
      version: item.version,
      library: LIBRARY,
      links: { self: { href: `http://127.0.0.1/api/users/0/items/${item.key}`, type: 'application/json' } },
      meta: {},
      data: item.data,
    };
  }

  function toCollectionResponse(collection) {
    return {
      key: collection.key,
      version: collection.version,
      library: LIBRARY,
      links: {},
      meta: { numItems: [...state.items.values()].filter(item => (item.data.collections ?? []).includes(collection.key)).length },
      data: collection.data,
    };
  }

  function stripMeta(entry) {
    const data = { ...entry };
    delete data.key;
    delete data.version;
    delete data.library;
    delete data.links;
    delete data.meta;
    return data;
  }

  function withTotal(headers, total) {
    return { ...headers, 'Total-Results': String(total) };
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    state,
    /** Seed one item and return its key. */
    seedItem(data) {
      const key = state.nextItemKey();
      const item = { key, version: state.bump(), data: { ...data } };
      state.items.set(key, item);
      return key;
    },
    /** Seed one collection and return its key. */
    seedCollection(data) {
      const key = state.nextCollectionKey();
      state.collections.set(key, { key, version: state.bump(), data: { ...data } });
      return key;
    },
    /** Seed full text for an attachment key. */
    seedFulltext(key, content, pages = { indexedPages: 3, totalPages: 3 }) {
      state.fulltext.set(key, {
        content,
        indexedPages: pages.indexedPages,
        totalPages: pages.totalPages,
        indexedChars: content.length,
        totalChars: content.length,
      });
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} contentType
 * @param {string} body
 * @param {Record<string, string>} [headers]
 */
function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': contentType, ...headers });
  response.end(body);
}