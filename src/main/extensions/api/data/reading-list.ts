import { defineApi, defineEvent, emit, ExtensionError } from '../../router'
import { getGlobalState, setGlobalState } from '../../state'
import { isObject, isString } from './util'

/**
 * chrome.readingList: a list kept for extensions (shared by all of them, like Chrome's). The app
 * has no reading list of its own to show it in.
 */

type Entry = chrome.readingList.ReadingListEntry

const load = (): Entry[] => getGlobalState<Entry[]>('readingList', [])
const save = (entries: Entry[]): void => setGlobalState('readingList', entries)

function checkUrl(url: unknown): string {
  if (!isString(url)) throw new ExtensionError('URL is not valid.')
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    return parsed.href
  } catch {
    throw new ExtensionError('URL is not valid.')
  }
}

function addEntry(_call: unknown, entry: unknown): void {
  const e = isObject(entry) ? entry : {}
  const url = checkUrl(e.url)
  if (!isString(e.title)) throw new ExtensionError('Invalid title.')
  if (typeof e.hasBeenRead !== 'boolean') throw new ExtensionError('Invalid hasBeenRead.')
  const entries = load()
  if (entries.some((x) => x.url === url)) throw new ExtensionError('Duplicate URL.')
  const now = Date.now()
  const added: Entry = { url, title: e.title, hasBeenRead: e.hasBeenRead, creationTime: now, lastUpdateTime: now }
  save([...entries, added])
  emit('readingList.onEntryAdded', [added])
}

function removeEntry(_call: unknown, info: unknown): void {
  const url = checkUrl(isObject(info) ? info.url : undefined)
  const entries = load()
  const removed = entries.find((x) => x.url === url)
  if (!removed) throw new ExtensionError('URL not found.')
  save(entries.filter((x) => x !== removed))
  emit('readingList.onEntryRemoved', [removed])
}

function updateEntry(_call: unknown, info: unknown): void {
  const i = isObject(info) ? info : {}
  const url = checkUrl(i.url)
  if (i.title === undefined && i.hasBeenRead === undefined) throw new ExtensionError('At least one of `title` or `hasBeenRead` must be provided.')
  const entries = load()
  const index = entries.findIndex((x) => x.url === url)
  if (index === -1) throw new ExtensionError('URL not found.')
  const updated: Entry = {
    ...entries[index],
    ...(isString(i.title) ? { title: i.title } : {}),
    ...(typeof i.hasBeenRead === 'boolean' ? { hasBeenRead: i.hasBeenRead } : {}),
    lastUpdateTime: Date.now()
  }
  entries[index] = updated
  save([...entries])
  emit('readingList.onEntryUpdated', [updated])
}

function query(_call: unknown, info: unknown): Entry[] {
  const q = isObject(info) ? info : {}
  const url = q.url === undefined ? undefined : checkUrl(q.url)
  return load().filter(
    (x) =>
      (url === undefined || x.url === url) &&
      (!isString(q.title) || x.title === q.title) &&
      (typeof q.hasBeenRead !== 'boolean' || x.hasBeenRead === q.hasBeenRead)
  )
}

defineApi('readingList', {
  permissions: ['readingList'],
  methods: { addEntry, removeEntry, updateEntry, query }
})

for (const name of ['onEntryAdded', 'onEntryRemoved', 'onEntryUpdated']) defineEvent(`readingList.${name}`, { permissions: ['readingList'] })
