/**
 * Filesystem locations and small atomic-write helpers shared by the plugin.
 *
 * The profile data directory belongs to the running profile: `DSH_PROFILE_DIR`
 * is set when `dsh web` starts from a profile shell, and the fallback keeps a
 * bare terminal launch from writing into the wrong place.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

/** Directory name this plugin owns inside `plugin-data`. */
export const PLUGIN_NAME = 'dsh-zotero'

/**
 * Resolve the directory this plugin may keep its own files in.
 * @returns the absolute directory path.
 */
export function dataDirectory() {
  const profile = process.env['DSH_PROFILE_DIR']
  if (typeof profile === 'string' && profile.trim() !== '') {
    return join(profile, 'plugin-data', PLUGIN_NAME)
  }
  return join(homedir(), '.dsh', 'plugin-data', PLUGIN_NAME)
}

/**
 * Read and parse a JSON file.
 * @param path - absolute file path.
 * @returns the parsed value, or null when the file is missing or unreadable.
 */
export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write a JSON file through a temporary sibling plus rename, so a crash never
 * leaves a half-written document behind.
 * @param path - absolute file path.
 * @param value - any JSON-serializable value.
 * @returns a promise that settles when the rename is visible to readers.
 */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true }).catch(() => {})
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

/**
 * Clamp a user-supplied number into `[min, max]`, falling back to a default.
 * @param value - the raw value, possibly undefined or not a number.
 * @param fallback - default applied when `value` is not a finite number.
 * @param min - smallest accepted value.
 * @param max - largest accepted value.
 * @returns the clamped integer.
 */
export function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}