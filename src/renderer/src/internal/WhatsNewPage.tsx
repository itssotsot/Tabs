import type { ReactNode } from 'react'
import { APP_VERSION, CHANGELOG, ChangelogText } from '../ui/changelog'

/** browserr://whats-new: every version's notes, newest first. */
export function WhatsNewPage(): ReactNode {
  return (
    <main className="page">
      <header className="page-head">
        <h1>What's New</h1>
      </header>

      {CHANGELOG.map((entry) => (
        <section key={entry.version} className="card changelog">
          <h2>
            Tabs {entry.version}
            {entry.version === APP_VERSION && <span className="changelog-current">This version</span>}
          </h2>
          <ul>
            {entry.items.map((item) => (
              <li key={item}>
                <ChangelogText text={item} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
