import { store } from '../../../store'
import { defineApi } from '../../router'

/** chrome.topSites: the app's most visited sites (the ones the new tab page shows). */

const MAX_TOP_SITES = 10

defineApi('topSites', {
  permissions: ['topSites'],
  methods: {
    get: (): chrome.topSites.MostVisitedURL[] =>
      store.topSites(MAX_TOP_SITES).map((site) => ({ url: site.url, title: site.title === site.url ? '' : site.title }))
  }
})
