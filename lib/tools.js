/**
 * The `zotero_*` tools exposed to the model.
 *
 * Every tool returns plain Markdown text: the model reads it directly, so the
 * output stays stable, compact, and explicit about what the next step can be.
 * Write tools are only reached after Zotero has granted a key; the client
 * handles that dialog, so a tool call may block on the user for one approval.
 */

import { ZoteroError } from './client.js';
import {
  annotationBlock,
  annotationColorName,
  annotationSummary,
  attachmentLabel,
  itemData,
  itemDetail,
  itemLine,
  sortAnnotations,
  tagNames,
  toBibtex,
  truncate,
} from './format.js';
import { htmlToText, markdownToNoteHtml } from './html.js';
import {
  ITEM_TYPES,
  ProviderError,
  candidateLine,
  normalizeDoi,
  relatedOpenalex,
  resolveIdentifier,
  searchAll,
  splitIdentifiers,
  toZoteroItem,
} from './providers.js';

/** Marker for combined string output. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Build a tool definition without importing the harness.
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.description
 * @param {Record<string, unknown>} spec.properties
 * @param {string[]} [spec.required]
 * @param {(args: any, exec: any) => Promise<string>} spec.run
 * @returns {object}
 */
function define(spec) {
  const parameters = { type: 'object', properties: spec.properties, additionalProperties: false };
  if (spec.required && spec.required.length > 0) parameters.required = spec.required;
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.();
      try {
        return await spec.run(args ?? {});
      } catch (error) {
        return failureText(error);
      }
    },
  };
}

/**
 * Render any failure as model-readable text with a fix-it hint.
 * @param {unknown} error
 * @returns {string}
 */
function failureText(error) {
  if (error instanceof ZoteroError) return `ERROR: ${error.display}`;
  if (error instanceof ProviderError) return `ERROR: ${error.message}`;
  const message = error instanceof Error ? error.message : String(error);
  return `ERROR: ${message}`;
}

/**
 * Clamp an integer argument into bounds.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

/**
 * Require a non-empty string argument.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

/**
 * Render a byte count as a short human-readable size.
 * @param {number} bytes
 * @returns {string}
 */
function humanSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '?';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Resolve collection names or keys to keys.
 * @param {import('./client.js').ZoteroClient} client
 * @param {string[]} values
 * @returns {Promise<{ keys: string[], missing: string[] }>}
 */
async function resolveCollectionKeys(client, values) {
  if (!values.length) return { keys: [], missing: [] };
  const collections = await client.listCollections();
  const byKey = new Map(collections.map(collection => [collection.key, collection]));
  const byName = new Map(collections.map(collection => [String(itemData(collection).name ?? '').toLowerCase(), collection.key]));
  const keys = [];
  const missing = [];
  for (const value of values) {
    if (byKey.has(value)) {
      keys.push(value);
      continue;
    }
    const key = byName.get(value.toLowerCase());
    if (key === undefined) missing.push(value);
    else keys.push(key);
  }
  return { keys, missing };
}

/**
 * Gather the reading material of one paper: its attachments, their
 * annotations, and the notes attached to it.
 * @param {import('./client.js').ZoteroClient} client
 * @param {string} key - paper, attachment, or annotation key.
 * @returns {Promise<{ item: any, attachments: { attachment: any, annotations: any[] }[], notes: any[], annotations: any[] }>}
 */
async function collectReadingMaterial(client, key) {
  const item = await client.getItem(key);
  const data = itemData(item);
  const collected = { item, attachments: [], notes: [], annotations: [] };
  if (data.itemType === 'annotation') {
    collected.annotations = [item];
    return collected;
  }
  const children = await client.getChildren(key).catch(() => []);
  if (data.itemType === 'attachment') {
    const annotations = await client.getChildren(key, { itemType: 'annotation' }).catch(() => []);
    collected.attachments.push({ attachment: item, annotations });
    collected.annotations = annotations;
    return collected;
  }
  collected.notes = children.filter(child => itemData(child).itemType === 'note');
  for (const attachment of children.filter(child => itemData(child).itemType === 'attachment')) {
    const annotations = await client.getChildren(attachment.key, { itemType: 'annotation' }).catch(() => []);
    if (annotations.length > 0) collected.attachments.push({ attachment, annotations });
  }
  collected.annotations = collected.attachments.flatMap(entry => entry.annotations);
  return collected;
}

/**
 * Filter annotations by color, type, and tag.
 * @param {any[]} annotations
 * @param {{ color?: string, type?: string, tag?: string }} filters
 * @returns {any[]}
 */
function filterAnnotations(annotations, filters) {
  return annotations.filter(annotation => {
    const data = itemData(annotation);
    if (filters.color) {
      const wanted = filters.color.toLowerCase();
      const color = String(data.annotationColor ?? '').toLowerCase();
      const named = annotationColorName(color).toLowerCase();
      if (color !== wanted && named !== wanted) return false;
    }
    if (filters.type && String(data.annotationType ?? '') !== filters.type) return false;
    if (filters.tag) {
      const wanted = filters.tag.toLowerCase();
      if (!tagNames(data).some(tag => tag.toLowerCase() === wanted)) return false;
    }
    return true;
  });
}

/**
 * Render a note item as text.
 * @param {any} note
 * @param {number} index
 * @returns {string}
 */
function noteBlock(note, index) {
  const data = itemData(note);
  return `### Note [${note.key}] (${data.dateAdded ?? 'no date'})\n${truncate(htmlToText(data.note ?? ''), 4000)}`;
}

/**
 * Describe a library item with its title and key only.
 * @param {any} item
 * @returns {string}
 */
function itemHeading(item) {
  const data = itemData(item);
  const title = typeof data.title === 'string' && data.title.trim() !== ''
    ? data.title.trim()
    : data.itemType === 'note' ? '(note)' : '(untitled)';
  return `${title} [${item.key}]`;
}

/**
 * Create the tool definitions bound to one client.
 * @param {import('./client.js').ZoteroClient} client
 * @returns {object[]}
 */
export function createZoteroTools(client) {
  return [
    define({
      name: 'zotero_status',
      description: 'Diagnose the Zotero bridge: whether Zotero is running and its local API is enabled, '
        + 'the server and schema versions, whether a write key is cached, and how large the library is. '
        + 'Call this first when another zotero_* tool fails, or to confirm what the bridge can do.',
      properties: {},
      run: async () => {
        const probe = await client.probe();
        const lines = ['# Zotero bridge status'];
        if (!probe.ok) {
          lines.push(`state: NOT USABLE (HTTP ${probe.status || 'unreachable'})`);
          if (probe.error) lines.push(`detail: ${probe.error}`);
          lines.push('', 'fix: start Zotero; then in Zotero open Settings -> Advanced and enable '
            + '"Allow other applications on this computer to communicate with Zotero" '
            + '(中文：设置 → 高级 → 勾选「允许本计算机上的其他应用程序与 Zotero 通信」).');
          return lines.join('\n');
        }
        lines.push(`state: ready at ${client.baseUrl}`);
        if (probe.zoteroVersion) lines.push(`zotero version: ${probe.zoteroVersion}`);
        if (probe.apiVersion) lines.push(`api version: ${probe.apiVersion}`);
        if (probe.schemaVersion) lines.push(`schema version: ${probe.schemaVersion}`);
        if (probe.serverId) lines.push(`server id: ${probe.serverId}`);
        const auth = await client.readAuth();
        lines.push(auth
          ? `write key: cached (${auth.remember ? 'persistent' : 'single-use'})${auth.createdAt ? ` since ${auth.createdAt}` : ''}`
          : 'write key: none yet (the first write opens a Zotero approval dialog)');
        const [items, trashed, collections, tags] = await Promise.all([
          client.searchItems({ limit: 1 }),
          client.searchItems({ limit: 1, trash: true }),
          client.listCollections(),
          client.listTags({ limit: 200 }),
        ]);
        lines.push(`library: ${items.total} item(s), ${trashed.total} in trash, ${collections.length} collection(s), ${tags.length} tag(s)`);
        lines.push('', 'capabilities: search/read the library, read annotations and notes, read indexed '
          + 'PDF text, add papers from DOI/arXiv/PMID/ISBN/URL or external search, update metadata, '
          + 'tag, file into collections, trash or erase items, manage collections.');
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_search',
      description: 'Search the user\'s Zotero library. Returns matching items with their 8-character keys, '
        + 'which the other tools accept. Read-only.',
      properties: {
        query: { type: 'string', description: 'Free text. Default matches titles, creators, and years; use mode "everything" for all fields.' },
        mode: { type: 'string', enum: ['titleCreatorYear', 'everything'], description: 'Quick-search mode; defaults to titleCreatorYear.' },
        itemType: { type: 'string', description: 'Zotero item type filter, e.g. journalArticle, conferencePaper, preprint, note, attachment.' },
        tag: { type: 'string', description: 'Tag filter.' },
        collection: { type: 'string', description: 'Collection key: restrict results to that collection.' },
        top: { type: 'boolean', description: 'Only top-level items, leaving out child notes, attachments and annotations; defaults to true unless itemType names one of those child types.' },
        trash: { type: 'boolean', description: 'Search the trash instead of the live library.' },
        sort: { type: 'string', description: 'dateModified (default), dateAdded, title, creator, date, publisher, publicationTitle.' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction; defaults to descending for date fields.' },
        limit: { type: 'integer', description: 'Page size, 1-100; defaults to 20.' },
        offset: { type: 'integer', description: 'Zero-based offset into the result set.' },
      },
      run: async args => {
        const limit = clamp(args.limit, 20, 1, 100);
        const offset = clamp(args.offset, 0, 0, 100000);
        const childType = typeof args.itemType === 'string'
          && ['note', 'attachment', 'annotation'].includes(args.itemType.trim());
        const result = await client.searchItems({
          q: typeof args.query === 'string' && args.query.trim() !== '' ? args.query.trim() : undefined,
          qmode: args.mode === 'everything' ? 'everything' : undefined,
          itemType: typeof args.itemType === 'string' ? args.itemType : undefined,
          tag: typeof args.tag === 'string' ? args.tag : undefined,
          collectionKey: typeof args.collection === 'string' && args.collection !== '' ? args.collection : undefined,
          top: args.top ?? !childType,
          trash: args.trash === true,
          sort: typeof args.sort === 'string' ? args.sort : undefined,
          direction: args.direction === 'asc' ? 'asc' : args.direction === 'desc' ? 'desc' : undefined,
          limit,
          start: offset,
        });
        if (result.total === 0) {
          return `No items matched${args.query ? ` "${args.query}"` : ''}${args.trash ? ' in the trash' : ''}.`;
        }
        const shown = result.items.slice(0, limit);
        const lines = [
          `${result.total} match(es); showing ${offset + 1}-${offset + shown.length}.`,
          '',
          ...shown.map((item, index) => itemLine(item, offset + index + 1)),
          '',
          `next: zotero_get with a key above for details${result.total > offset + shown.length ? `, or offset=${offset + shown.length} for the next page` : ''}.`,
        ];
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_get',
      description: 'Read one or more library items in full: metadata, tags, collections, children (attachments/notes), '
        + 'and optionally note bodies, annotations, indexed full text, and BibTeX. Read-only.',
      properties: {
        key: { type: 'string', description: 'Item key from zotero_search.' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Several item keys to read at once (max 20).' },
        notes: { type: 'boolean', description: 'Include the body of each child note.' },
        annotations: { type: 'boolean', description: 'Include the annotation transcript of each PDF attachment.' },
        fulltext: { type: 'boolean', description: 'Include the indexed full text of the first PDF attachment.' },
        bibtex: { type: 'boolean', description: 'Include a generated BibTeX entry.' },
        children: { type: 'boolean', description: 'List child items; defaults to true.' },
      },
      run: async args => {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter(key => typeof key === 'string' && key !== '').slice(0, 20)
          : [];
        if (typeof args.key === 'string' && args.key !== '') keys.unshift(args.key);
        if (keys.length === 0) throw new Error('key or keys is required');
        const collectionNames = new Map(
          (await client.listCollections().catch(() => [])).map(collection => [collection.key, itemData(collection).name ?? '']),
        );
        const blocks = [];
        for (const key of [...new Set(keys)]) {
          const item = await client.getItem(key);
          const data = itemData(item);
          const includeChildren = args.children !== false;
          const kids = includeChildren ? await client.getChildren(key).catch(() => []) : [];
          if (includeChildren && data.itemType === 'attachment') {
            const annotationKids = await client.getChildren(key, { itemType: 'annotation' }).catch(() => []);
            kids.push(...annotationKids);
          }
          let parentLabel;
          if (typeof data.parentItem === 'string' && data.parentItem !== '') {
            const parent = await client.getItem(data.parentItem).catch(() => undefined);
            const parentData = parent === undefined ? undefined : itemData(parent);
            if (typeof parentData?.title === 'string' && parentData.title !== '') parentLabel = parentData.title;
          }
          const options = { collectionNames, children: includeChildren ? kids : [], parentLabel };
          if (args.fulltext === true) {
            const attachment = kids.find(child => itemData(child).itemType === 'attachment'
              && String(itemData(child).contentType ?? '').includes('pdf'))
              ?? kids.find(child => itemData(child).itemType === 'attachment');
            if (attachment) {
              try {
                const fulltext = await client.getFulltext(attachment.key);
                options.fulltext = fulltext.content
                  ? truncate(fulltext.content, 4000)
                  : '(Zotero has not indexed text for this attachment yet)';
              } catch {
                options.fulltext = '(no indexed text available)';
              }
            }
          }
          let detail = itemDetail(item, options);
          if (args.bibtex === true) detail += `\n\n## BibTeX\n${toBibtex(item)}`;
          if (args.annotations === true) {
            const collected = await collectReadingMaterial(client, key);
            if (collected.annotations.length > 0) {
              const ordered = sortAnnotations(collected.annotations);
              detail += `\n\n## Annotations (${ordered.length})\n${ordered.map((annotation, index) => annotationBlock(annotation, index + 1)).join('\n\n')}`;
            } else {
              detail += '\n\n## Annotations\n(none)';
            }
          }
          if (args.notes === true) {
            const notes = kids.filter(child => itemData(child).itemType === 'note');
            if (notes.length > 0) {
              detail += `\n\n## Notes (${notes.length})`;
              notes.forEach((note, index) => {
                detail += `\n\n${noteBlock(note, index + 1)}`;
              });
            }
          }
          blocks.push(detail);
        }
        return blocks.join('\n\n---\n\n');
      },
    }),

    define({
      name: 'zotero_annotations',
      description: 'Read the annotations a reader made on a paper: highlights, underlines, notes, images, and ink, '
        + 'with quoted text, reader comments, page labels, and colors, in reading order, plus the notes attached '
        + 'to the paper. This is the tool to call before deep-reading or summarizing a paper.',
      properties: {
        key: { type: 'string', description: 'Paper key, or an attachment/annotation key.' },
        color: { type: 'string', description: 'Filter by color name (yellow, red, green, blue, purple, magenta, orange, gray) or hex.' },
        type: { type: 'string', enum: ['highlight', 'underline', 'note', 'text', 'image', 'ink'], description: 'Filter by annotation type.' },
        tag: { type: 'string', description: 'Filter by an annotation tag.' },
        includeNotes: { type: 'boolean', description: 'Include notes attached to the paper; defaults to true.' },
        limit: { type: 'integer', description: 'Maximum annotations to render, 1-500; defaults to 200.' },
        offset: { type: 'integer', description: 'Zero-based offset into the annotation list.' },
      },
      run: async args => {
        const key = requireString(args.key, 'key');
        const limit = clamp(args.limit, 200, 1, 500);
        const offset = clamp(args.offset, 0, 0, 100000);
        const collected = await collectReadingMaterial(client, key);
        const data = itemData(collected.item);
        const filtered = sortAnnotations(filterAnnotations(collected.annotations, args));
        const lines = [`# Annotations — ${itemHeading(collected.item)}`];
        if (data.itemType === 'attachment') lines.push(`attachment: ${attachmentLabel(data)} · ${data.filename ?? ''}`);
        if (collected.attachments.length > 1) {
          lines.push(`attachments with annotations: ${collected.attachments.map(entry => itemData(entry.attachment).filename ?? entry.attachment.key).join(', ')}`);
        }
        lines.push(`count: ${filtered.length}${collected.annotations.length !== filtered.length ? ` of ${collected.annotations.length}` : ''}`);
        if (filtered.length > 0) lines.push(`mix: ${annotationSummary(filtered)}`);
        lines.push('');
        if (filtered.length === 0) {
          lines.push(collected.annotations.length > 0
            ? 'No annotation matched the filter.'
            : 'This paper has no annotations. Annotations appear here after the user highlights or comments '
              + 'a PDF in Zotero, and only when Zotero has imported them.');
        } else {
          const page = filtered.slice(offset, offset + limit);
          if (offset > 0) lines.push(`(continuing at annotation ${offset + 1} of ${filtered.length})`, '');
          lines.push(...page.map((annotation, index) => `${annotationBlock(annotation, offset + index + 1)}\n`));
          if (offset + page.length < filtered.length) {
            lines.push(`… ${filtered.length - offset - page.length} more annotation(s); call again with offset=${offset + page.length}.`);
          }
        }
        if (args.includeNotes !== false && collected.notes.length > 0) {
          lines.push('', `## Notes on this paper (${collected.notes.length})`, '');
          collected.notes.forEach((note, index) => {
            lines.push(noteBlock(note, index + 1), '');
          });
        }
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_fulltext',
      description: 'Read the text Zotero indexed from a paper\'s PDF attachment (page by page is not separated, '
        + 'but the total indexed pages are reported). Use offset and maxChars to page through long papers, '
        + 'or find to jump to a phrase.',
      properties: {
        key: { type: 'string', description: 'Paper key or attachment key.' },
        offset: { type: 'integer', description: 'Character offset to start at; defaults to 0.' },
        maxChars: { type: 'integer', description: 'Characters to return, 500-40000; defaults to 12000.' },
        find: { type: 'string', description: 'Phrase to jump to; returns a window around its first match.' },
      },
      required: ['key'],
      run: async args => {
        const key = requireString(args.key, 'key');
        const item = await client.getItem(key);
        const data = itemData(item);
        let attachmentKey = key;
        let attachment = item;
        if (data.itemType !== 'attachment') {
          const children = await client.getChildren(key).catch(() => []);
          const pdf = children.find(child => itemData(child).itemType === 'attachment'
            && String(itemData(child).contentType ?? '').includes('pdf'))
            ?? children.find(child => itemData(child).itemType === 'attachment');
          if (!pdf) {
            return `${itemHeading(item)} has no attachment, so there is no indexed text. `
              + 'Attach a PDF in Zotero first.';
          }
          attachmentKey = pdf.key;
          attachment = pdf;
        }
        let fulltext;
        try {
          fulltext = await client.getFulltext(attachmentKey);
        } catch (error) {
          if (error instanceof ZoteroError && error.status === 404) {
            return `No indexed text for ${itemHeading(attachment)}.\n`
              + 'Zotero only exposes text it has already indexed: open the file in Zotero (or re-save the item) '
              + 'once so the full-text index exists, then retry.';
          }
          throw error;
        }
        const content = fulltext.content;
        if (content === '') return `Zotero has an empty full-text index for ${itemHeading(attachment)}.`;
        const maxChars = clamp(args.maxChars, 12000, 500, 40000);
        let start = clamp(args.offset, 0, 0, content.length);
        let header = `# Full text — ${itemHeading(attachment)}\nchars ${start}-${Math.min(start + maxChars, content.length)} of ${content.length} · `
          + `indexed pages ${fulltext.indexedPages}/${fulltext.totalPages}\n`;
        const needle = typeof args.find === 'string' && args.find.trim() !== '' ? args.find.trim() : '';
        if (needle !== '') {
          const haystack = content.toLowerCase();
          const at = haystack.indexOf(needle.toLowerCase());
          if (at < 0) {
            return `${header}\n"${needle}" does not appear in the indexed text.`;
          }
          start = Math.max(0, at - Math.floor(maxChars / 3));
          header = `# Full text — ${itemHeading(attachment)}\nfound "${needle}" at char ${at} · chars ${start}-${Math.min(start + maxChars, content.length)} of ${content.length}\n`;
        }
        const slice = content.slice(start, start + maxChars);
        const footer = start + maxChars < content.length
          ? `\n\n… ${content.length - start - maxChars} more char(s); continue with offset=${start + maxChars}.`
          : '\n\n(end of indexed text)';
        return `${header}\n${slice}${footer}`;
      },
    }),

    define({
      name: 'zotero_note',
      description: 'Work with Zotero notes: list the notes attached to an item or matching a search, read a note, '
        + 'and create, rewrite, append to, or delete a note. Note content is written as Markdown and stored as a Zotero note.',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'append', 'delete'], description: 'Operation; defaults to list.' },
        item: { type: 'string', description: 'Parent item key, for list (filter) and create.' },
        note: { type: 'string', description: 'Note item key, for get/update/append/delete.' },
        query: { type: 'string', description: 'For list without item: free-text search over all notes.' },
        content: { type: 'string', description: 'Markdown body, for create/update/append.' },
        permanent: { type: 'boolean', description: 'For delete: erase permanently instead of moving to the trash.' },
        limit: { type: 'integer', description: 'For list: maximum notes to show, 1-100; defaults to 30.' },
      },
      run: async args => {
        const action = typeof args.action === 'string' ? args.action : 'list';
        const limit = clamp(args.limit, 30, 1, 100);
        switch (action) {
          case 'list': {
            let notes = [];
            if (typeof args.item === 'string' && args.item !== '') {
              notes = (await client.getChildren(args.item)).filter(child => itemData(child).itemType === 'note');
            } else {
              const result = await client.searchItems({
                q: typeof args.query === 'string' && args.query !== '' ? args.query : undefined,
                qmode: 'everything',
                itemType: 'note',
                limit,
              });
              notes = result.items;
            }
            if (notes.length === 0) return 'No notes found.';
            const lines = [`${notes.length} note(s):`, ''];
            notes.slice(0, limit).forEach(note => {
              const data = itemData(note);
              const first = htmlToText(data.note ?? '').split('\n')[0] ?? '';
              lines.push(`- [${note.key}] ${data.dateAdded ?? ''} ${data.parentItem ? `(on ${data.parentItem})` : '(standalone)'} · ${truncate(first, 160)}`);
            });
            return lines.join('\n');
          }
          case 'get': {
            const noteKey = requireString(args.note, 'note');
            const note = await client.getItem(noteKey);
            const data = itemData(note);
            if (data.itemType !== 'note') throw new Error(`${noteKey} is a ${data.itemType}, not a note`);
            return `# Note [${noteKey}]\nparent: ${data.parentItem ?? '(standalone)'} · added ${data.dateAdded ?? '?'} · modified ${data.dateModified ?? '?'}\n\n${htmlToText(data.note ?? '')}`;
          }
          case 'create': {
            const content = requireString(args.content, 'content');
            const entry = { itemType: 'note', note: markdownToNoteHtml(content) };
            if (typeof args.item === 'string' && args.item !== '') entry.parentItem = args.item;
            const result = await client.writeItems([entry]);
            if (result.failed.length > 0) return `ERROR: ${result.failed[0].message}`;
            const created = result.ok[0];
            return `Created note [${created.key}]${entry.parentItem ? ` on ${entry.parentItem}` : ''}.\n${truncate(htmlToText(markdownToNoteHtml(content)), 400)}`;
          }
          case 'update': {
            const noteKey = requireString(args.note, 'note');
            const content = requireString(args.content, 'content');
            const updated = await client.patchObject('items', noteKey, { note: markdownToNoteHtml(content) });
            return `Rewrote note [${noteKey}].\n\n${truncate(htmlToText(itemData(updated).note ?? ''), 1200)}`;
          }
          case 'append': {
            const noteKey = requireString(args.note, 'note');
            const content = requireString(args.content, 'content');
            const current = await client.getItem(noteKey);
            const existing = String(itemData(current).note ?? '');
            const updated = await client.patchObject('items', noteKey, { note: `${existing}${markdownToNoteHtml(content)}` });
            return `Appended to note [${noteKey}]; it is now ${String(itemData(updated).note ?? '').length} characters of HTML.`;
          }
          case 'delete': {
            const noteKey = requireString(args.note, 'note');
            const result = await client.deleteItems([noteKey], { permanent: args.permanent === true });
            if (result.failed.length > 0) return `ERROR: ${result.failed[0].message}`;
            return `Deleted note [${noteKey}]${args.permanent === true ? ' permanently' : ' (moved to trash)'}.`;
          }
          default:
            throw new Error(`unknown action "${action}"`);
        }
      },
    }),

    define({
      name: 'zotero_add',
      description: 'Add papers to the Zotero library. Three ways to say what to add: (1) identifiers — DOIs, arXiv ids, '
        + 'PMIDs, ISBNs, or URLs; (2) items — raw Zotero item JSON objects; (3) search — a topic that is looked up in '
        + 'OpenAlex/Crossref/arXiv and whose top results are added. Optionally file them into collections and tag them. '
        + 'Duplicates are skipped by default.',
      properties: {
        identifiers: { type: 'array', items: { type: 'string' }, description: 'DOI, arXiv id, PMID, ISBN, or URL strings.' },
        items: { type: 'array', items: { type: 'object' }, description: 'Raw Zotero item JSON objects; each must carry itemType.' },
        search: { type: 'string', description: 'Topic to search in external sources, e.g. "graph neural networks for molecules".' },
        sources: { type: 'array', items: { type: 'string', enum: ['openalex', 'crossref', 'arxiv'] }, description: 'Sources for search; defaults to all three.' },
        limit: { type: 'integer', description: 'For search: how many top results to add, 1-20; defaults to 5.' },
        fromYear: { type: 'integer', description: 'For search: ignore works published before this year.' },
        sort: { type: 'string', enum: ['relevance', 'citations'], description: 'For search: rank by relevance (default) or citation count.' },
        itemType: { type: 'string', enum: ITEM_TYPES, description: 'Force one Zotero item type for every added record.' },
        collection: { type: 'string', description: 'Collection key or exact name to file the new items into.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to set on every added item.' },
        skipDuplicates: { type: 'boolean', description: 'Skip records whose DOI already exists in the library; defaults to true.' },
        dryRun: { type: 'boolean', description: 'Resolve and report what would be added without writing.' },
      },
      run: async args => {
        const entries = [];
        const skipped = [];
        const problems = [];
        const collections = await resolveCollectionKeys(client, [
          ...(typeof args.collection === 'string' && args.collection !== '' ? [args.collection] : []),
        ]);
        if (collections.missing.length > 0) throw new Error(`Unknown collection: ${collections.missing.join(', ')}`);
        const tags = Array.isArray(args.tags) ? args.tags.filter(tag => typeof tag === 'string' && tag !== '') : [];
        const itemType = typeof args.itemType === 'string' && args.itemType !== '' ? args.itemType : undefined;

        if (Array.isArray(args.items)) {
          for (const item of args.items) {
            if (!item || typeof item !== 'object' || typeof item.itemType !== 'string') {
              problems.push('an item object without itemType was ignored');
              continue;
            }
            const merged = { ...item };
            if (collections.keys.length > 0 && merged.collections === undefined) merged.collections = collections.keys;
            if (tags.length > 0) {
              const names = new Set(
                (Array.isArray(merged.tags) ? merged.tags : [])
                  .map(entry => (typeof entry === 'string' ? entry : entry?.tag))
                  .filter(name => typeof name === 'string' && name !== ''),
              );
              for (const tag of tags) names.add(tag);
              merged.tags = [...names].map(tag => ({ tag }));
            }
            entries.push(merged);
          }
        }

        const identifiers = Array.isArray(args.identifiers)
          ? args.identifiers.flatMap(value => (typeof value === 'string' ? splitIdentifiers(value) : []))
          : [];
        for (const identifier of identifiers) {
          try {
            const candidate = await resolveIdentifier(identifier);
            entries.push(toZoteroItem(candidate, { itemType, collections: collections.keys, tags }));
          } catch (error) {
            problems.push(`${identifier}: ${error?.message ?? error}`);
          }
        }

        if (typeof args.search === 'string' && args.search.trim() !== '') {
          const limit = clamp(args.limit, 5, 1, 20);
          const { candidates, errors } = await searchAll(args.search.trim(), {
            limit: Math.min(limit, 10),
            fromYear: Number.isFinite(Number(args.fromYear)) ? Number(args.fromYear) : undefined,
            sources: Array.isArray(args.sources) ? args.sources : undefined,
            sort: args.sort === 'citations' ? 'citations' : 'relevance',
          });
          problems.push(...errors);
          if (candidates.length === 0) {
            return `No external result for "${args.search.trim()}".${problems.length ? `\n${problems.join('\n')}` : ''}`;
          }
          for (const candidate of candidates.slice(0, limit)) {
            entries.push(toZoteroItem(candidate, { itemType, collections: collections.keys, tags }));
          }
        }

        if (entries.length === 0) {
          return `Nothing to add.${problems.length ? `\n${problems.join('\n')}` : ''}`;
        }

        const unique = [];
        if (args.skipDuplicates !== false) {
          const seen = new Set();
          for (const entry of entries) {
            const doi = typeof entry.DOI === 'string' ? normalizeDoi(entry.DOI) : '';
            if (doi === '') {
              unique.push(entry);
              continue;
            }
            const existing = await client.searchItems({ q: doi, qmode: 'everything', limit: 5 }).catch(() => ({ items: [] }));
            const duplicate = existing.items.find(item => normalizeDoi(String(itemData(item).DOI ?? '')) === doi);
            if (duplicate) {
              skipped.push(`DOI ${doi} already in library as [${duplicate.key}] — ${itemData(duplicate).title ?? ''}`);
            } else if (seen.has(doi)) {
              skipped.push(`DOI ${doi} appeared twice in this request`);
            } else {
              seen.add(doi);
              unique.push(entry);
            }
          }
        } else {
          unique.push(...entries);
        }

        const preview = unique.slice(0, 20).map((entry, index) => `${index + 1}. ${entry.itemType} · ${entry.title ?? '(no title)'}${entry.DOI ? ` · doi:${entry.DOI}` : ''}`);
        if (args.dryRun === true) {
          return ['# Dry run — nothing written', `${unique.length} item(s) would be added:`, ...preview,
            ...skipped.length ? ['', 'skipped as duplicates:', ...skipped] : [],
            ...problems.length ? ['', 'problems:', ...problems] : []].join('\n');
        }

        const result = await client.writeItems(unique);
        const lines = [`# Added ${result.ok.length} of ${unique.length} item(s)`];
        for (const entry of result.ok) {
          const data = itemData(entry.item ?? {});
          lines.push(`- [${entry.key}] ${data.title ?? unique[entry.index]?.title ?? '(no title)'}`);
        }
        if (result.unchanged.length > 0) lines.push(`unchanged: ${result.unchanged.map(entry => entry.key).join(', ')}`);
        if (result.failed.length > 0) {
          lines.push('', 'failed:');
          for (const failure of result.failed) {
            lines.push(`- ${unique[failure.index]?.title ?? `index ${failure.index}`}: ${failure.code} ${failure.message}`);
          }
        }
        if (skipped.length > 0) lines.push('', 'skipped as duplicates:', ...skipped);
        if (problems.length > 0) lines.push('', 'problems:', ...problems);
        if (collections.keys.length > 0) lines.push('', `filed into: ${collections.keys.join(', ')}`);
        if (tags.length > 0) lines.push(`tagged: ${tags.join(', ')}`);
        lines.push('', 'next: zotero_search or zotero_get with a key above to verify.');
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_attach',
      description: 'Attach local files (for example PDFs) to an existing item by uploading them into the Zotero '
        + 'storage directory. Zotero extracts full text in the background; the upload also nudges its indexer so '
        + 'new files are extracted straight away (a few seconds per file). Pass wait to hold until the text is '
        + 'actually indexed, which makes zotero_fulltext usable right after.',
      properties: {
        parent: { type: 'string', description: 'Item key of the paper (parent item) that owns these files.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the files to attach (1-20).' },
        title: { type: 'string', description: 'Attachment title; only when attaching a single file (defaults to the file name).' },
        wait: { type: 'boolean', description: 'Wait up to 60 seconds for Zotero to finish indexing the uploaded files (default false).' },
      },
      required: ['parent', 'paths'],
      run: async (args) => {
        const parent = requireString(args.parent, 'parent');
        const paths = Array.isArray(args.paths)
          ? args.paths.filter(path => typeof path === 'string' && path.trim() !== '').map(path => path.trim())
          : [];
        if (paths.length === 0) throw new Error('paths is required');
        if (paths.length > 20) throw new Error('attach at most 20 files at a time');
        const title = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : undefined;
        if (title !== undefined && paths.length > 1) throw new Error('title applies to a single file only');

        const lines = [`# Attached to [${parent}]`];
        const fresh = [];
        for (const path of paths) {
          try {
            const result = await client.attachFile(parent, path, { title });
            if (!result.existed) fresh.push(result.key);
            lines.push(`- [${result.key}] ${result.filename} · ${humanSize(result.size)} · ${result.contentType}`
              + `${result.existed ? ' · file already stored' : ''}`);
          } catch (error) {
            lines.push(`- ${path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (fresh.length > 0) {
          await client.kickFulltextQueue().catch(() => {});
        }
        if (args.wait === true && fresh.length > 0) {
          const { indexed, pending } = await client.waitForFulltext(fresh);
          for (const entry of indexed) {
            lines.push(`- [${entry.key}] indexed · ${entry.pages} page(s) · ${humanSize(entry.chars)} of text`);
          }
          if (pending.length > 0) {
            lines.push('', `still indexing after 60s: ${pending.join(', ')} — retry zotero_fulltext later, `
              + 'or leave Zotero idle for a moment.');
          }
        } else if (fresh.length > 0) {
          lines.push('', 'Zotero is indexing the uploaded files now; zotero_fulltext may answer 404 for a few '
            + 'seconds until the pass finishes (pass wait:true to hold for it).');
        }
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_update',
      description: 'Update library items: merge raw Zotero fields, add or remove tags, add or remove collection '
        + 'membership, or move items to the trash and restore them. Read-modify-write with version checks.',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Item keys to update (1-50).' },
        key: { type: 'string', description: 'One item key to update.' },
        patch: { type: 'string', description: 'JSON object string of raw Zotero fields to merge, e.g. {"title":"...","pub…' },
        addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to add.' },
        removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove.' },
        addCollections: { type: 'array', items: { type: 'string' }, description: 'Collection keys or names to add the items to.' },
        removeCollections: { type: 'array', items: { type: 'string' }, description: 'Collection keys or names to remove the items from.' },
        trash: { type: 'boolean', description: 'Move the items to the trash (reversible).' },
        restore: { type: 'boolean', description: 'Restore the items from the trash.' },
      },
      run: async args => {
        const keys = Array.isArray(args.keys)
          ? args.keys.filter(key => typeof key === 'string' && key !== '')
          : [];
        if (typeof args.key === 'string' && args.key !== '') keys.unshift(args.key);
        if (keys.length === 0) throw new Error('key or keys is required');
        let patch = {};
        if (typeof args.patch === 'string' && args.patch.trim() !== '') {
          let parsed;
          try {
            parsed = JSON.parse(args.patch);
          } catch (error) {
            throw new Error(`patch is not valid JSON: ${error.message}`);
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('patch must be a JSON object');
          patch = parsed;
        }
        const addTags = Array.isArray(args.addTags) ? args.addTags.filter(tag => typeof tag === 'string' && tag !== '') : [];
        const removeTags = Array.isArray(args.removeTags) ? args.removeTags.filter(tag => typeof tag === 'string' && tag !== '') : [];
        const addCollections = await resolveCollectionKeys(client,
          Array.isArray(args.addCollections) ? args.addCollections.filter(value => typeof value === 'string') : []);
        const removeCollections = await resolveCollectionKeys(client,
          Array.isArray(args.removeCollections) ? args.removeCollections.filter(value => typeof value === 'string') : []);
        if (addCollections.missing.length > 0) throw new Error(`Unknown collection: ${addCollections.missing.join(', ')}`);
        if (removeCollections.missing.length > 0) throw new Error(`Unknown collection: ${removeCollections.missing.join(', ')}`);

        const lines = [];
        for (const key of [...new Set(keys)]) {
          const item = await client.getItem(key);
          const data = itemData(item);
          const next = { ...patch };
          if (addTags.length > 0 || removeTags.length > 0) {
            const existing = tagNames(data);
            const removed = new Set(removeTags.map(tag => tag.toLowerCase()));
            const merged = existing.filter(tag => !removed.has(tag.toLowerCase()));
            for (const tag of addTags) {
              if (!merged.some(current => current.toLowerCase() === tag.toLowerCase())) merged.push(tag);
            }
            next.tags = merged.map(tag => ({ tag }));
          }
          const currentCollections = Array.isArray(data.collections) ? data.collections : [];
          if (addCollections.keys.length > 0 || removeCollections.keys.length > 0) {
            const removed = new Set(removeCollections.keys);
            const merged = currentCollections.filter(collection => !removed.has(collection));
            for (const collection of addCollections.keys) {
              if (!merged.includes(collection)) merged.push(collection);
            }
            next.collections = merged;
          }
          if (args.trash === true) next.deleted = true;
          if (args.restore === true) next.deleted = false;
          if (Object.keys(next).length === 0) {
            lines.push(`- [${key}] nothing to change`);
            continue;
          }
          const updated = await client.patchObject('items', key, next);
          const updatedData = itemData(updated);
          lines.push(`- [${key}] ${updatedData.title ?? itemHeading(item)} · v${updated.version}`
            + `${Array.isArray(updatedData.tags) && updatedData.tags.length ? ` · tags: ${tagNames(updatedData).join(', ')}` : ''}`
            + `${Array.isArray(updatedData.collections) && updatedData.collections.length ? ` · collections: ${updatedData.collections.join(', ')}` : ''}`
            + `${updatedData.deleted === true ? ' · IN TRASH' : ''}`);
        }
        return ['# Updated', ...lines].join('\n');
      },
    }),

    define({
      name: 'zotero_delete',
      description: 'Delete items or collections. By default items move to the trash, which is reversible and keeps '
        + 'their files. Permanent erase requires permanent and confirm; it cannot be undone and does not sync '
        + 'deletions to other devices gracefully.',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: 'Item keys to delete.' },
        collections: { type: 'array', items: { type: 'string' }, description: 'Collection keys or names to delete (items stay in the library).' },
        permanent: { type: 'boolean', description: 'Erase permanently instead of moving items to the trash.' },
        confirm: { type: 'boolean', description: 'Required with permanent; acknowledges the erase cannot be undone.' },
      },
      run: async args => {
        const keys = Array.isArray(args.keys) ? args.keys.filter(key => typeof key === 'string' && key !== '') : [];
        const collections = await resolveCollectionKeys(client,
          Array.isArray(args.collections) ? args.collections.filter(value => typeof value === 'string') : []);
        if (collections.missing.length > 0) throw new Error(`Unknown collection: ${collections.missing.join(', ')}`);
        if (keys.length === 0 && collections.keys.length === 0) throw new Error('keys or collections is required');
        const permanent = args.permanent === true;
        if (permanent && args.confirm !== true) {
          return 'Refusing to erase permanently: pass confirm=true. Nothing was deleted. '
            + 'Without permanent the items move to the trash and can be restored.';
        }
        const lines = [];
        if (keys.length > 0) {
          const result = await client.deleteItems(keys, { permanent });
          if (result.deleted.length > 0) lines.push(`${permanent ? 'erased' : 'moved to trash'}: ${result.deleted.join(', ')}`);
          for (const failure of result.failed) lines.push(`failed [${failure.key}]: ${failure.message}`);
        }
        for (const collection of collections.keys) {
          try {
            await client.deleteCollection(collection);
            lines.push(`deleted collection ${collection} (its items remain in the library)`);
          } catch (error) {
            lines.push(`failed to delete collection ${collection}: ${error?.message ?? error}`);
          }
        }
        lines.push('', permanent ? 'Permanent erase cannot be undone.' : 'Restore with zotero_update restore=true on the keys.');
        return lines.join('\n');
      },
    }),

    define({
      name: 'zotero_collections',
      description: 'List, inspect, create, rename, or delete Zotero collections (folders). Collections organize items; '
        + 'an item can sit in several at once, and deleting a collection never deletes its items.',
      properties: {
        action: { type: 'string', enum: ['list', 'tree', 'get', 'create', 'rename', 'delete'], description: 'Operation; defaults to list.' },
        key: { type: 'string', description: 'Collection key, for get/rename/delete.' },
        name: { type: 'string', description: 'Collection name, for create/rename.' },
        parent: { type: 'string', description: 'Parent collection key or name, for create.' },
        limit: { type: 'integer', description: 'For list: maximum collections, 1-500; defaults to 200.' },
      },
      run: async args => {
        const action = typeof args.action === 'string' ? args.action : 'list';
        const limit = clamp(args.limit, 200, 1, 500);
        switch (action) {
          case 'list': {
            const collections = (await client.listCollections()).slice(0, limit);
            if (collections.length === 0) return 'No collections yet.';
            const lines = [`${collections.length} collection(s):`, ''];
            for (const collection of collections) {
              const data = itemData(collection);
              lines.push(`- [${collection.key}] ${data.name ?? '(unnamed)'}`
                + `${data.parentCollection ? ` · parent ${data.parentCollection}` : ''}`
                + `${Number.isFinite(data.meta?.numItems) ? ` · ${data.meta.numItems} item(s)` : ''}`);
            }
            return lines.join('\n');
          }
          case 'tree': {
            const collections = await client.listCollections();
            const byParent = new Map();
            for (const collection of collections) {
              const parent = itemData(collection).parentCollection ?? '';
              const list = byParent.get(parent) ?? [];
              list.push(collection);
              byParent.set(parent, list);
            }
            const lines = [`${collections.length} collection(s):`, ''];
            const walk = (parent, depth) => {
              for (const collection of (byParent.get(parent) ?? []).sort((left, right) => String(itemData(left).name ?? '').localeCompare(String(itemData(right).name ?? '')))) {
                const data = itemData(collection);
                lines.push(`${'  '.repeat(depth)}- ${data.name ?? '(unnamed)'} [${collection.key}]`
                  + `${Number.isFinite(data.meta?.numItems) ? ` · ${data.meta.numItems} item(s)` : ''}`);
                walk(collection.key, depth + 1);
              }
            };
            walk('', 0);
            if (lines.length === 2) lines.push('(no collections)');
            return lines.join('\n');
          }
          case 'get': {
            const key = requireString(args.key, 'key');
            const collection = await client.getCollection(key);
            const data = itemData(collection);
            const [items, children] = await Promise.all([
              client.searchItems({ collectionKey: key, limit: 20, sort: 'dateModified', direction: 'desc' }),
              client.listCollections().then(list => list.filter(entry => itemData(entry).parentCollection === key)),
            ]);
            const lines = [`# ${data.name ?? '(unnamed)'} [${key}]`,
              `items: ${items.total} · subcollections: ${children.length}${data.parentCollection ? ` · parent: ${data.parentCollection}` : ''}`, ''];
            items.items.forEach((item, index) => lines.push(itemLine(item, index + 1)));
            return lines.join('\n');
          }
          case 'create': {
            const name = requireString(args.name, 'name');
            const entry = { name };
            if (typeof args.parent === 'string' && args.parent !== '') {
              const parent = await resolveCollectionKeys(client, [args.parent]);
              if (parent.missing.length > 0) throw new Error(`Unknown parent collection: ${args.parent}`);
              entry.parentCollection = parent.keys[0];
            }
            const result = await client.writeCollections([entry]);
            if (result.failed.length > 0) return `ERROR: ${result.failed[0].message}`;
            return `Created collection "${name}" [${result.ok[0].key}].`;
          }
          case 'rename': {
            const key = requireString(args.key, 'key');
            const name = requireString(args.name, 'name');
            const updated = await client.patchObject('collections', key, { name });
            return `Renamed [${key}] to "${itemData(updated).name ?? name}".`;
          }
          case 'delete': {
            const key = requireString(args.key, 'key');
            const collection = await client.getCollection(key);
            await client.deleteCollection(key);
            return `Deleted collection "${itemData(collection).name ?? key}" [${key}]. Its items are still in the library.`;
          }
          default:
            throw new Error(`unknown action "${action}"`);
        }
      },
    }),

    define({
      name: 'zotero_find',
      description: 'Search scholarly sources outside Zotero (OpenAlex, Crossref, arXiv) for papers to add, or list '
        + 'works OpenAlex relates to a seed paper. Returns candidate records with DOIs; pass those DOIs to '
        + 'zotero_add identifiers to import them. Read-only.',
      properties: {
        query: { type: 'string', description: 'Topic or title words to search.' },
        source: { type: 'string', enum: ['all', 'openalex', 'crossref', 'arxiv'], description: 'Which source to use; defaults to all.' },
        limit: { type: 'integer', description: 'Candidates per source, 1-25; defaults to 10.' },
        fromYear: { type: 'integer', description: 'Ignore works published before this year.' },
        sort: { type: 'string', enum: ['relevance', 'citations'], description: 'OpenAlex ranking; defaults to relevance.' },
        related_to: { type: 'string', description: 'DOI or OpenAlex work id; returns OpenAlex related works instead of a text search.' },
      },
      run: async args => {
        const relatedTo = typeof args.related_to === 'string' ? args.related_to.trim() : '';
        const limit = clamp(args.limit, 10, 1, 25);
        if (relatedTo !== '') {
          const candidates = await relatedOpenalex(relatedTo, { limit });
          if (candidates.length === 0) return `OpenAlex lists no related works for ${relatedTo}.`;
          return ['# Related works in OpenAlex', '', ...candidates.map((candidate, index) => candidateLine(candidate, index + 1)),
            '', 'next: zotero_add with identifiers=[<DOIs above>].'].join('\n');
        }
        const query = requireString(args.query, 'query');
        const source = typeof args.source === 'string' ? args.source : 'all';
        const { candidates, errors } = await searchAll(query, {
          limit,
          fromYear: Number.isFinite(Number(args.fromYear)) ? Number(args.fromYear) : undefined,
          sort: args.sort === 'citations' ? 'citations' : 'relevance',
          sources: source === 'all' ? undefined : [source],
        });
        const lines = [`# ${candidates.length} candidate(s) for "${query}"`, ''];
        lines.push(...candidates.map((candidate, index) => candidateLine(candidate, index + 1)));
        if (errors.length > 0) lines.push('', 'source problems:', ...errors);
        lines.push('', 'next: pass chosen DOIs to zotero_add identifiers=[...] to import them, or '
          + 'zotero_add search="..." to import the top results directly.');
        return lines.join('\n');
      },
    }),
  ];
}