import { Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { deleteShare } from '../../social/api'
import { useSocial } from '../../social/SocialProvider'
import { ShareCard } from './ShareCard'

export function SentPanel(): ReactNode {
  const { sent, people } = useSocial()

  if (!sent.length) {
    return (
      <div className="panel-empty">
        <Send size={28} strokeWidth={1.5} />
        <h3>Nothing sent yet</h3>
        <p>Links you send show up here, along with whether your friend opened them and how they reacted.</p>
      </div>
    )
  }

  return (
    <div className="share-list">
      {sent.map((share) => (
        <ShareCard
          key={share.id}
          share={share}
          person={people[share.to]}
          direction="out"
          onOpen={(background) => window.browserr.openUrl(share.url, background)}
          onDelete={() => {
            if (confirm('Unsend this link? It will disappear for your friend too.')) void deleteShare(share.id)
          }}
        />
      ))}
    </div>
  )
}
