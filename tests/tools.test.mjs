/**
 * End-to-end tests for the zotero_* tools against a fake local API.
 *
 * The fake server reproduces the checks in Zotero's `server_localAPI.js`:
 * server-id and API-key requirements for writes, optimistic version checks,
 * the trash flag, and the multi-object write protocol.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '../lib/client.js';
import { detectIdentifier, normalizeDoi, splitIdentifiers, toZoteroItem } from '../lib/providers.js';
import { createZoteroTools } from '../lib/tools.js';
import { startFakeZotero } from './fake-zotero.mjs';

const REAL_FETCH = globalThis.fetch;

/**
 * Start a fake Zotero, build a client and tools, run `body`, then clean up.
 * @param {(context: any) => Promise<void>} body
 * @param {{ enabled?: boolean, remember?: boolean, seed?: (server: any) => void }} [options]
 */
async function withZotero(body, options = {}) {
  const server = await startFakeZotero({ enabled: options.enabled, remember: options.remember });
  const directory = await mkdtemp(join(tmpdir(), 'dsh-zotero-'));
  const client = createClient({
    baseUrl: `${server.origin}/api`,
    authFile: join(directory, 'auth.json'),
    fetchImpl: REAL_FETCH,
  });
  const tools = new Map(createZoteroTools(client).map(definition => [definition.name, definition]));
  options.seed?.(server);
  try {
    await body({
      server,
      client,
      directory,
      tools,
      run: (name, args) => tools.get(name).execute(args, {}),
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** A paper with a PDF attachment, annotations, a note, and a DOI. */
function seedPaper(server) {
  const paperKey = server.seedItem({
    itemType: 'journalArticle',
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP',
    creators: [
      { creatorType: 'author', firstName: 'Patrick', lastName: 'Lewis' },
      { creatorType: 'author', firstName: 'Ethan', lastName: 'Perez' },
    ],
    date: '2020-05-22',
    publicationTitle: 'NeurIPS',
    DOI: '10.5555/rag.2020',
    abstractNote: 'We explore RAG.',
    tags: [{ tag: 'rag' }, { tag: 'reading' }],
  });
  const attachmentKey = server.seedItem({
    itemType: 'attachment',
    parentItem: paperKey,
    title: 'Full Text PDF',
    filename: 'rag.pdf',
    contentType: 'application/pdf',
    linkMode: 'imported_file',
  });
  const annotations = [
    { annotationType: 'highlight', annotationText: 'first highlighted claim', annotationComment: 'important', annotationColor: '#ffd400', annotationPageLabel: '3', annotationSortIndex: '00002' },
    { annotationType: 'highlight', annotationText: 'second claim, later in the paper', annotationColor: '#ff6666', annotationPageLabel: '9', annotationSortIndex: '00005' },
    { annotationType: 'note', annotationComment: 'my thought about the method', annotationColor: '#ffd400', annotationPageLabel: '5', annotationSortIndex: '00004' },
  ];
  for (const annotation of annotations) {
    server.seedItem({ itemType: 'annotation', parentItem: attachmentKey, ...annotation });
  }
  const noteKey = server.seedItem({
    itemType: 'note',
    parentItem: paperKey,
    note: '<h1>Summary</h1><p>RAG combines a retriever with a generator.</p>',
  });
  server.seedFulltext(attachmentKey, 'RAG page one text. '.repeat(40) + 'the retrieval step matters ' + 'tail text. '.repeat(40));
  return { paperKey, attachmentKey, noteKey };
}

test('status explains a disabled local API', async () => {
  await withZotero(async ({ run }) => {
    const text = await run('zotero_status', {});
    assert.match(text, /NOT USABLE/);
    assert.match(text, /Settings -> Advanced/);
  }, { enabled: false });
});

test('status reports readiness, auth state and library size', async () => {
  await withZotero(async ({ run }) => {
    const text = await run('zotero_status', {});
    assert.match(text, /state: ready/);
    assert.match(text, /api version: 3/);
    assert.match(text, /server id: FAKE0000SRV1/);
    assert.match(text, /write key: none yet/);
    assert.match(text, /library: \d+ item\(s\), 0 in trash, 1 collection\(s\), 2 tag\(s\)/);
  }, {
    seed: server => {
      seedPaper(server);
      server.seedCollection({ name: 'Papers' });
    },
  });
});

test('search filters by text, type and tag', async () => {
  await withZotero(async ({ run }) => {
    const byText = await run('zotero_search', { query: 'Retrieval-Augmented' });
    assert.match(byText, /1 match\(es\)/);
    assert.match(byText, /journalArticle/);
    assert.match(byText, /DOI 10\.5555\/rag\.2020/);

    const byType = await run('zotero_search', { itemType: 'note' });
    assert.match(byType, /note/);
    assert.doesNotMatch(byType, /journalArticle/);

    const byTag = await run('zotero_search', { tag: 'rag' });
    assert.match(byTag, /1 match\(es\)/);

    const empty = await run('zotero_search', { query: 'nothing matches this' });
    assert.match(empty, /No items matched/);
  }, { seed: seedPaper });
});

test('get renders metadata, children, note bodies and BibTeX', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const detail = await run('zotero_get', { key: paperKey, notes: true, bibtex: true });
    assert.match(detail, /Retrieval-Augmented Generation/);
    assert.match(detail, /Lewis, Patrick/);
    assert.match(detail, /links: DOI 10\.5555\/rag\.2020/);
    assert.match(detail, /tags: rag, reading/);
    assert.match(detail, /## Notes \(1\)/);
    assert.match(detail, /RAG combines a retriever with a generator/);
    assert.match(detail, /@article\{lewis2020retrieval/);
    assert.match(detail, /journal = \{NeurIPS\}/);

    const missing = await run('zotero_get', { key: 'NOPE0000' });
    assert.match(missing, /^ERROR: Not found \(404\)/);
  });
});

test('annotations read in order, with quotes, comments, colors and notes', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey, attachmentKey } = seedPaper(server);
    const text = await run('zotero_annotations', { key: paperKey });
    assert.match(text, /count: 3/);
    assert.match(text, /3 highlight.*1 note|2 highlight, 1 note/);
    const first = text.indexOf('first highlighted claim');
    const second = text.indexOf('second claim, later in the paper');
    const third = text.indexOf('my thought about the method');
    assert.ok(first > 0 && third > first && second > third, 'annotations follow annotationSortIndex');
    assert.match(text, /p\.3/);
    assert.match(text, /comment: important/);
    assert.match(text, /## Notes on this paper \(1\)/);

    const yellow = await run('zotero_annotations', { key: paperKey, color: 'yellow' });
    assert.match(yellow, /count: 2/);
    assert.doesNotMatch(yellow, /second claim/);

    const notesOnly = await run('zotero_annotations', { key: paperKey, type: 'note' });
    assert.match(notesOnly, /count: 1/);
    assert.match(notesOnly, /my thought about the method/);

    const viaAttachment = await run('zotero_annotations', { key: attachmentKey });
    assert.match(viaAttachment, /count: 3/);

    const noNotes = await run('zotero_annotations', { key: paperKey, includeNotes: false });
    assert.doesNotMatch(noNotes, /## Notes on this paper/);
  });
});

test('fulltext pages through the index and jumps to a phrase', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const first = await run('zotero_fulltext', { key: paperKey, maxChars: 500 });
    assert.match(first, /indexed pages 3\/3/);
    assert.match(first, /continue with offset=500/);

    const window = await run('zotero_fulltext', { key: paperKey, find: 'retrieval step matters', maxChars: 500 });
    assert.match(window, /found "retrieval step matters" at char/);
    assert.match(window, /the retrieval step matters/);
  });
});

test('notes can be created, appended, read and trashed', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const created = await run('zotero_note', { action: 'create', item: paperKey, content: '## Idea\n\nUse a reranker.' });
    const match = created.match(/Created note \[([A-Z0-9]{8})\]/);
    assert.ok(match, created);
    const noteKey = match[1];

    const appended = await run('zotero_note', { action: 'append', note: noteKey, content: '\n\nSecond paragraph.' });
    assert.match(appended, new RegExp(`Appended to note \\[${noteKey}\\]`));

    const read = await run('zotero_note', { action: 'get', note: noteKey });
    assert.match(read, /Idea/);
    assert.match(read, /Use a reranker/);
    assert.match(read, /Second paragraph/);

    const list = await run('zotero_note', { action: 'list', item: paperKey });
    assert.match(list, new RegExp(noteKey));

    const trashed = await run('zotero_note', { action: 'delete', note: noteKey });
    assert.match(trashed, /moved to trash/);
    assert.equal(server.state.items.get(noteKey).data.deleted, true);
  });
});

test('add writes new items, files them, and skips duplicate DOIs', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const collectionKey = server.seedCollection({ name: 'Inbox' });

    const added = await run('zotero_add', {
      items: [
        { itemType: 'journalArticle', title: 'A New Paper', DOI: '10.1000/new' },
        { itemType: 'journalArticle', title: 'Duplicate Of Seeded', DOI: '10.5555/rag.2020' },
      ],
      collection: 'Inbox',
      tags: ['imported'],
    });
    assert.match(added, /Added 1 of 1 item\(s\)/);
    assert.match(added, /A New Paper/);
    assert.match(added, /skipped as duplicates:/);
    assert.match(added, /10\.5555\/rag\.2020/);

    const stored = [...server.state.items.values()].filter(item => item.data.title === 'A New Paper');
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].data.collections, [collectionKey]);
    assert.deepEqual(stored[0].data.tags, [{ tag: 'imported' }]);

    const dry = await run('zotero_add', {
      items: [{ itemType: 'journalArticle', title: 'Dry Run Only' }],
      dryRun: true,
    });
    assert.match(dry, /nothing written/);
    assert.equal([...server.state.items.values()].some(item => item.data.title === 'Dry Run Only'), false);
    assert.equal(server.state.items.get(paperKey).data.title.includes('Retrieval-Augmented'), true);
  });
});

test('add resolves identifiers through Crossref and imports metadata', async () => {
  const crossref = {
    message: {
      DOI: '10.1000/xyz.123',
      title: ['Identifier Imported Paper'],
      author: [{ family: 'Smith', given: 'Jane' }],
      issued: { 'date-parts': [[2021, 4, 1]] },
      'container-title': ['Journal of Tests'],
      type: 'journal-article',
      page: '1-10',
      volume: '7',
    },
  };
  globalThis.fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('api.crossref.org/works/10.1000/xyz.123')) {
      return new Response(JSON.stringify(crossref), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await withZotero(async ({ run, server }) => {
      const text = await run('zotero_add', { identifiers: ['https://doi.org/10.1000/xyz.123'] });
      assert.match(text, /Added 1 of 1/);
      const stored = [...server.state.items.values()].find(item => item.data.DOI === '10.1000/xyz.123');
      assert.ok(stored, text);
      assert.equal(stored.data.title, 'Identifier Imported Paper');
      assert.equal(stored.data.itemType, 'journalArticle');
      assert.deepEqual(stored.data.creators, [{ creatorType: 'author', firstName: 'Jane', lastName: 'Smith' }]);
    });
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test('attach uploads a local PDF and registers it under the paper', async () => {
  await withZotero(async ({ run, server, directory }) => {
    const { paperKey } = seedPaper(server);
    const bytes = Buffer.from('%PDF-1.4 test payload for the upload handshake');
    const filePath = join(directory, 'paper.pdf');
    await writeFile(filePath, bytes);

    const text = await run('zotero_attach', { parent: paperKey, paths: [filePath] });
    assert.match(text, new RegExp(`# Attached to \\[${paperKey}\\]`));
    assert.match(text, new RegExp(`paper\\.pdf · ${bytes.length} B · application/pdf`));

    const attachment = [...server.state.items.values()]
      .find(item => item.data.parentItem === paperKey && item.data.filename === 'paper.pdf');
    assert.ok(attachment, text);
    assert.equal(attachment.data.itemType, 'attachment');
    assert.equal(attachment.data.contentType, 'application/pdf');
    assert.equal(attachment.data.fileBytes, bytes.length);
    assert.equal(attachment.data.fileMd5, createHash('md5').update(bytes).digest('hex'));
  });
});

test('attach reports a missing file and leaves no attachment behind', async () => {
  await withZotero(async ({ run, server, directory }) => {
    const { paperKey } = seedPaper(server);
    const missing = join(directory, 'nope.pdf');
    const text = await run('zotero_attach', { parent: paperKey, paths: [missing] });
    assert.match(text, /nope\.pdf/);
    assert.match(text, /ENOENT|no such file/i);
    const leftovers = [...server.state.items.values()].filter(item => item.data.filename === 'nope.pdf');
    assert.equal(leftovers.length, 0);
  });
});

test('update merges fields, tags and collections, and toggles the trash', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const collectionKey = server.seedCollection({ name: 'Reading' });

    const updated = await run('zotero_update', {
      key: paperKey,
      patch: JSON.stringify({ title: 'RAG, renamed' }),
      addTags: ['deep-read'],
      removeTags: ['reading'],
      addCollections: ['Reading'],
    });
    assert.match(updated, /\[.*\] RAG, renamed/);
    assert.match(updated, /tags: rag, deep-read/);
    assert.match(updated, new RegExp(`collections: ${collectionKey}`));

    const stored = server.state.items.get(paperKey);
    assert.equal(stored.data.title, 'RAG, renamed');
    assert.deepEqual(stored.data.tags, [{ tag: 'rag' }, { tag: 'deep-read' }]);

    const trashed = await run('zotero_update', { key: paperKey, trash: true });
    assert.match(trashed, /IN TRASH/);
    assert.equal(server.state.items.get(paperKey).data.deleted, true);

    const restored = await run('zotero_update', { key: paperKey, restore: true });
    assert.doesNotMatch(restored, /IN TRASH/);
    assert.equal(server.state.items.get(paperKey).data.deleted, undefined);

    const bad = await run('zotero_update', { key: paperKey, patch: '{not json' });
    assert.match(bad, /^ERROR: patch is not valid JSON/);
  });
});

test('delete trashes by default and erases only with confirm', async () => {
  await withZotero(async ({ run, server }) => {
    const { paperKey } = seedPaper(server);
    const trashTarget = server.seedItem({ itemType: 'journalArticle', title: 'Trash me' });
    const eraseTarget = server.seedItem({ itemType: 'journalArticle', title: 'Erase me' });

    const trashed = await run('zotero_delete', { keys: [trashTarget] });
    assert.match(trashed, /moved to trash/);
    assert.equal(server.state.items.get(trashTarget).data.deleted, true);
    assert.equal(server.state.items.has(paperKey), true);

    const refused = await run('zotero_delete', { keys: [eraseTarget], permanent: true });
    assert.match(refused, /Refusing to erase permanently/);
    assert.equal(server.state.items.has(eraseTarget), true);

    const erased = await run('zotero_delete', { keys: [eraseTarget], permanent: true, confirm: true });
    assert.match(erased, /erased/);
    assert.equal(server.state.items.has(eraseTarget), false);
  });
});

test('collections can be listed, created, renamed and deleted', async () => {
  await withZotero(async ({ run, server }) => {
    const parent = server.seedCollection({ name: 'Reading' });
    const child = server.seedCollection({ name: 'To Read', parentCollection: parent });

    const list = await run('zotero_collections', {});
    assert.match(list, /Reading/);
    assert.match(list, /To Read/);

    const tree = await run('zotero_collections', { action: 'tree' });
    assert.match(tree, /- Reading/);
    assert.match(tree, /  - To Read/);

    const created = await run('zotero_collections', { action: 'create', name: 'New Topic', parent: 'Reading' });
    assert.match(created, /Created collection "New Topic"/);
    const createdKey = created.match(/\[([A-Z0-9]{8})\]/)[1];
    assert.equal(server.state.collections.get(createdKey).data.parentCollection, parent);

    const renamed = await run('zotero_collections', { action: 'rename', key: child, name: 'Reading Queue' });
    assert.match(renamed, /Reading Queue/);

    const deleted = await run('zotero_collections', { action: 'delete', key: createdKey });
    assert.match(deleted, /Deleted collection/);
    assert.equal(server.state.collections.has(createdKey), false);

    const get = await run('zotero_collections', { action: 'get', key: parent });
    assert.match(get, /subcollections: 1/);
  });
});

test('the first write authorizes once and reuses the cached key', async () => {
  await withZotero(async ({ run, server }) => {
    await run('zotero_add', { items: [{ itemType: 'journalArticle', title: 'First' }] });
    assert.equal(server.state.authorizeCalls, 1);
    await run('zotero_add', { items: [{ itemType: 'journalArticle', title: 'Second' }] });
    assert.equal(server.state.authorizeCalls, 1);
  });
});

test('an invalid cached key is dropped and re-authorized once', async () => {
  await withZotero(async ({ run, server }) => {
    await run('zotero_add', { items: [{ itemType: 'journalArticle', title: 'Warm up' }] });
    assert.equal(server.state.authorizeCalls, 1);
    server.state.keys.clear();
    const text = await run('zotero_add', { items: [{ itemType: 'journalArticle', title: 'After expiry' }] });
    assert.match(text, /Added 1 of 1/);
    assert.equal(server.state.authorizeCalls, 2);
  });
});

test('find lists external candidates and related works', async () => {
  const crossref = {
    message: {
      items: [{
        DOI: '10.1000/found',
        title: ['Found By Crossref'],
        author: [{ family: 'Doe', given: 'Jane' }],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['ICML'],
        type: 'proceedings-article',
      }],
    },
  };
  globalThis.fetch = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('api.crossref.org/works?')) {
      return new Response(JSON.stringify(crossref), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.openalex.org/works/doi:10.1000/seed')) {
      return new Response(JSON.stringify({
        id: 'https://openalex.org/W1',
        related_works: ['https://openalex.org/W2'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('api.openalex.org/works?filter=openalex_id:W2')) {
      return new Response(JSON.stringify({ results: [openalexWork()] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    await withZotero(async ({ run }) => {
      const found = await run('zotero_find', { query: 'retrieval augmented', source: 'crossref' });
      assert.match(found, /1 candidate\(s\)/);
      assert.match(found, /Found By Crossref/);
      assert.match(found, /doi:10\.1000\/found/);

      const related = await run('zotero_find', { related_to: '10.1000/seed' });
      assert.match(related, /Related works in OpenAlex/);
      assert.match(related, /Related Work One/);
    });
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test('provider helpers detect identifiers and build Zotero items', () => {
  assert.equal(detectIdentifier('https://doi.org/10.1145/3292500').kind, 'doi');
  assert.equal(detectIdentifier('arxiv:2101.00001').kind, 'arxiv');
  assert.equal(detectIdentifier('978-3-16-148410-0').kind, 'isbn');
  assert.equal(detectIdentifier('not an identifier'), null);
  assert.equal(normalizeDoi('https://doi.org/10.1145/ABC'), '10.1145/abc');
  assert.deepEqual(splitIdentifiers('10.1000/a; 10.1000/b'), ['10.1000/a', '10.1000/b']);
  const item = toZoteroItem({
    itemType: 'journalArticle',
    title: 'T',
    DOI: '10.1000/x',
    creators: [{ creatorType: 'author', firstName: 'A', lastName: 'B' }],
    abstractNote: 'abs',
    nonsenseField: 'dropped',
  }, { collections: ['C1'], tags: ['t1'] });
  assert.equal(item.itemType, 'journalArticle');
  assert.equal(item.nonsenseField, undefined);
  assert.equal(item.abstractNote, 'abs');
  assert.deepEqual(item.collections, ['C1']);
  assert.deepEqual(item.tags, [{ tag: 't1' }]);
});

/**
 * @returns {any} one OpenAlex work payload.
 */
function openalexWork() {
  return {
    id: 'https://openalex.org/W2',
    doi: 'https://doi.org/10.1000/related',
    title: 'Related Work One',
    publication_year: 2023,
    authorships: [{ author: { display_name: 'Roe, R.' } }],
    primary_location: { source: { display_name: 'ICLR' } },
    cited_by_count: 12,
    type: 'article',
  };
}