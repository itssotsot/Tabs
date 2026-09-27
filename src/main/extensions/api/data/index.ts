// Registers this group's chrome.* namespaces (each module calls defineApi/defineEvent when imported).
import './storage-sync'
import './downloads'
import './history'
import './bookmarks'
import './top-sites'
import './sessions'
import './reading-list'
import './search'
import './tab-groups'
import './omnibox'
import './identity'
import './management'
import './native-messaging'

export {
  omniboxDeleteSuggestion,
  omniboxInputCancelled,
  omniboxInputChanged,
  omniboxInputEntered,
  omniboxInputStarted,
  omniboxKeywordFor,
  omniboxKeywords,
  type OmniboxDisposition,
  type OmniboxKeyword,
  type OmniboxResult,
  type OmniboxSuggestion
} from './omnibox'
export { omniboxDescriptionText, omniboxSegments, type OmniboxSegment } from './omnibox-text'
export { downloadUiEnabled } from './downloads'
export { tabGroupId } from './tab-groups'
