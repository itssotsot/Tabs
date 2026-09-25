import type { ReactNode } from 'react'
import type { Profile } from '../social/api'

const COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#eab308', '#ef4444']

function colorFor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return COLORS[Math.abs(hash) % COLORS.length]
}

interface Props {
  profile: Profile | null | undefined
  size?: number
  photoURL?: string | null
}

export function Avatar({ profile, size = 28, photoURL }: Props): ReactNode {
  const src = photoURL ?? profile?.photoURL
  const name = profile?.displayName || profile?.username || '?'
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) }
  if (src) {
    return <img className="avatar" src={src} alt="" style={style} referrerPolicy="no-referrer" draggable={false} />
  }
  return (
    <span className="avatar avatar-letter" style={{ ...style, background: colorFor(profile?.uid ?? name) }}>
      {name.replace(/^@/, '').charAt(0).toUpperCase()}
    </span>
  )
}
