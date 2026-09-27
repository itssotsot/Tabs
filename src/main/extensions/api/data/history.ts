import type { HistoryEntry } from '@shared/types'
import { JsonFile, store, storeEvents } from '../../../store'
import { defineApi, defineEvent, emit, ExtensionError } from '../../router'
import { isNumber, isObject, isString, toMillis } from './util'

/**
 * chrome.history, on top of the app's history (one entry per URL with its last visit and visit
 * count). Chrome also has individual visits, so this module keeps a small log of visit times per
 * URL from now on, plus stable ids for HistoryItem.id; URLs visited before it existed get one visit,
 * their last.
 */

/** Visits remembered per URL (the most recent ones). */
const VISITS_PER_URL = 20
const DAY_MS = 86_400_000

interface Log {
  /** URL -> HistoryItem id. */
  ids: Record<string, string>
  nextId: number
  /** URL -> [visitId, time] pairs, oldest first. */
  visits: Record<string, [string, number][]>
  nextVisitId: number
}

let file: JsonFile<Log> | null = null
/** While deleteRange removes URLs one by one: report them together afterwards. */
let batch: string[] | null = null

function log(): Log {
  file ??= new JsonFile<Log>('extension-history-visits', { ids: {}, nextId: 1, visits: {}, nextVisitId: 1 })
  return file.data
}

function idFor(url: string): string {
  const l = log()
  let id = l.ids[url]
  if (!id) {
    id = String(l.nextId++)
    l.ids[url] = id
    file!.save()
  }
  return id
}

/** Visits of a URL, oldest first: logged ones, else just its last visit. */
function visitsOf(entry: HistoryEntry): [string, number][] {
  const logged = log().visits[entry.url]
  return logged?.length ? logged : [[`${idFor(entry.url)}-last`, entry.lastVisit]]
}

function toItem(entry: HistoryEntry): chrome.history.HistoryItem {
  return {
    id: idFor(entry.url),
    url: entry.url,
    title: entry.title === entry.url ? '' : entry.title,
    lastVisitTime: entry.lastVisit,
    visitCount: entry.visitCount,
    typedCount: 0
  }
}

storeEvents.on('history-visit', (entry) => {
  const l = log()
  const visits = (l.visits[entry.url] ??= [])
  visits.push([String(l.nextVisitId++), entry.lastVisit])
  if (visits.length > VISITS_PER_URL) visits.splice(0, visits.length - VISITS_PER_URL)
  file!.save()
  emit('history.onVisited', [toItem(entry)])
})

storeEvents.on('history-removed', ({ urls, all }) => {
  const l = log()
  if (all) {
    l.ids = {}
    l.visits = {}
  } else {
    for (const url of urls) {
      delete l.ids[url]
      delete l.visits[url]
    }
  }
  file!.save()
  if (batch && !all) {
    batch.push(...urls)
    return
  }
  emit('history.onVisitRemoved', [all ? { allHistory: true, urls: [] } : { allHistory: false, urls }])
})

function search(_call: unknown, query: unknown): chrome.history.HistoryItem[] {
  if (!isObject(query) || !isString(query.text)) throw new ExtensionError('Invalid query: text is required.')
  const now = Date.now()
  const start = query.startTime === undefined ? now - DAY_MS : toMillis(query.startTime)
  const end = query.endTime === undefined ? Infinity : toMillis(query.endTime)
  const max = isNumber(query.maxResults) ? Math.max(0, Math.floor(query.maxResults)) : 100
  const words = query.text.toLowerCase().split(/\s+/).filter(Boolean)
  const found = store.historyEntries().filter((entry) => {
    if (!visitsOf(entry).some(([, t]) => t >= start && t < end)) return false
    const hay = `${entry.url} ${entry.title}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  found.sort((a, b) => b.lastVisit - a.lastVisit)
  return (max ? found.slice(0, max) : found).map(toItem)
}

function getVisits(_call: unknown, details: unknown): chrome.history.VisitItem[] {
  const url = isObject(details) && isString(details.url) ? details.url : null
  if (!url) throw new ExtensionError('Url is invalid.')
  const entry = store.historyEntry(url)
  if (!entry) return []
  const id = idFor(url)
  return visitsOf(entry).map(([visitId, time]) => ({
    id,
    visitId,
    visitTime: time,
    referringVisitId: '0',
    transition: 'link' as chrome.history.TransitionType,
    isLocal: true
  }))
}

function addUrl(_call: unknown, details: unknown): void {
  const url = isObject(details) && isString(details.url) ? details.url : ''
  // The app's history keeps web pages only.
  if (!/^https?:\/\/[^/]/i.test(url)) throw new ExtensionError('Url is invalid.')
  try {
    new URL(url)
  } catch {
    throw new ExtensionError('Url is invalid.')
  }
  const title = isObject(details) && isString(details.title) ? details.title : ''
  store.recordVisit(url, title)
}

function deleteUrl(_call: unknown, details: unknown): void {
  const url = isObject(details) && isString(details.url) ? details.url : null
  if (!url) throw new ExtensionError('Url is invalid.')
  store.removeHistory(url)
}

/** Removes the visits in the range; URLs with no visits left leave history. */
function deleteRange(_call: unknown, range: unknown): void {
  if (!isObject(range)) throw new ExtensionError('Invalid range.')
  const start = toMillis(range.startTime)
  const end = toMillis(range.endTime)
  if (Number.isNaN(start) || Number.isNaN(end)) throw new ExtensionError('Invalid range.')
  const l = log()
  batch = []
  try {
    for (const entry of store.historyEntries()) {
      const visits = visitsOf(entry)
      const left = visits.filter(([, t]) => t < start || t >= end)
      if (left.length === visits.length) continue
      if (!left.length) store.removeHistory(entry.url)
      else l.visits[entry.url] = left
    }
    file!.save()
  } finally {
    const urls = batch
    batch = null
    if (urls.length) emit('history.onVisitRemoved', [{ allHistory: false, urls }])
  }
}

defineApi('history', {
  permissions: ['history'],
  methods: {
    search,
    getVisits,
    addUrl,
    deleteUrl,
    deleteRange,
    deleteAll: () => store.clearHistory()
  }
})

defineEvent('history.onVisited', { permissions: ['history'] })
defineEvent('history.onVisitRemoved', { permissions: ['history'] })
