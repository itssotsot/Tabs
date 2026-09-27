import type { ReactNode } from 'react'
import { colorFor } from '@shared/colors'
import type { Profile, Room } from '../social/api'

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

interface RoomAvatarProps {
  room: Room
  me: string
  people: Record<string, Profile | null>
  size?: number
}

/** The other members' faces, overlapped; the room's initial when you're alone in it. */
export function RoomAvatar({ room, me, people, size = 32 }: RoomAvatarProps): ReactNode {
  const others = room.members.filter((m) => m !== me).slice(0, 2)
  if (others.length === 0) {
    return (
      <span
        className="avatar avatar-letter room-avatar"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: colorFor(room.id) }}
      >
        {room.name.charAt(0).toUpperCase() || '#'}
      </span>
    )
  }
  if (others.length === 1) return <Avatar profile={people[others[0]]} size={size} />
  const small = Math.round(size * 0.72)
  return (
    <span className="avatar-stack" style={{ width: size, height: size }}>
      <Avatar profile={people[others[0]]} size={small} />
      <Avatar profile={people[others[1]]} size={small} />
    </span>
  )
}
