/**
 * DSH ⇄ Zotero bridge.
 *
 * The plugin talks to the Zotero desktop app over its local API
 * (`http://127.0.0.1:23119/api`), which must be enabled in Zotero under
 * Settings → Advanced. Reads need nothing else; the first write makes Zotero
 * show an authorization dialog, and the granted key is cached under
 * `<profile>/plugin-data/dsh-zotero/auth.json`.
 *
 * Everything here is host-side: eleven `zotero_*` tools and no UI.
 */

import { ZoteroClient } from './lib/client.js';
import { dataDirectory } from './lib/paths.js';
import { createZoteroTools } from './lib/tools.js';

export const name = 'dsh-zotero';

export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119/api';
const DEFAULT_TIMEOUT_MS = 20000;
const KNOWN_OPTIONS = new Set(['baseUrl', 'userId', 'timeoutMs', 'authFile']);

/**
 * Validate the plugin configuration.
 *
 * A host-only bundle cannot import the profile's Schemastery, so the fields are
 * checked here and a bad value fails the load instead of surfacing later as a
 * confusing tool error.
 *
 * @param {unknown} config - raw Loader configuration.
 * @returns {{ baseUrl: string, userId: number, timeoutMs: number, authFile: string }}
 */
function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_OPTIONS.has(key)) throw new Error(`dsh-zotero: unknown option "${key}"`);
  }
  const baseUrl = raw.baseUrl === undefined ? DEFAULT_BASE_URL : raw.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new Error('dsh-zotero: config.baseUrl must be an http(s) URL');
  }
  const userId = raw.userId === undefined ? 0 : Number(raw.userId);
  if (!Number.isInteger(userId) || userId < 0) throw new Error('dsh-zotero: config.userId must be a non-negative integer');
  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('dsh-zotero: config.timeoutMs must be at least 1000');
  const authFile = raw.authFile === undefined
    ? `${dataDirectory()}/auth.json`
    : raw.authFile;
  if (typeof authFile !== 'string' || authFile === '') throw new Error('dsh-zotero: config.authFile must be a path');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), userId, timeoutMs, authFile };
}

/**
 * Register the Zotero tools.
 * @param ctx - plugin context; `tools` is injected.
 * @param config - Loader configuration.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const client = new ZoteroClient({
    baseUrl: resolved.baseUrl,
    userId: resolved.userId,
    timeoutMs: resolved.timeoutMs,
    authFile: resolved.authFile,
  });
  for (const definition of createZoteroTools(client)) {
    ctx.tools.register(definition);
  }
}