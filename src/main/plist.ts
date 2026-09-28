/** Reads a binary property list (Safari's bookmarks and last session). Dates and data come back as null. */
export function parseBinaryPlist(buf: Buffer): unknown {
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') throw new Error('Not a binary plist')
  const trailer = buf.subarray(buf.length - 32)
  const offsetSize = trailer[6]
  const refSize = trailer[7]
  const count = Number(trailer.readBigUInt64BE(8))
  const top = Number(trailer.readBigUInt64BE(16))
  const table = Number(trailer.readBigUInt64BE(24))
  const uint = (at: number, size: number): number => {
    let n = 0
    for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]
    return n
  }
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offsetSize, offsetSize))
  const depth = new Set<number>()

  const read = (ref: number): unknown => {
    if (depth.has(ref) || depth.size > 64) throw new Error('Bad plist')
    depth.add(ref)
    try {
      return readObject(offsets[ref])
    } finally {
      depth.delete(ref)
    }
  }

  const readObject = (at: number): unknown => {
    const marker = buf[at]
    const type = marker >> 4
    const info = marker & 0xf
    // The length of strings, arrays and so on, and where their contents start.
    const sized = (): [number, number] => {
      if (info !== 0xf) return [info, at + 1]
      const intSize = 1 << (buf[at + 1] & 0xf)
      return [uint(at + 2, intSize), at + 2 + intSize]
    }
    switch (type) {
      case 0x0:
        return info === 0x9 ? true : info === 0x8 ? false : null
      case 0x1:
        return uint(at + 1, 1 << info)
      case 0x2:
        return info === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1)
      case 0x5: {
        const [len, start] = sized()
        return buf.toString('latin1', start, start + len)
      }
      case 0x6: {
        const [len, start] = sized()
        const chars = Buffer.from(buf.subarray(start, start + len * 2))
        return chars.swap16().toString('utf16le')
      }
      case 0xa: {
        const [len, start] = sized()
        return Array.from({ length: len }, (_, i) => read(uint(start + i * refSize, refSize)))
      }
      case 0xd: {
        const [len, start] = sized()
        const dict: Record<string, unknown> = {}
        for (let i = 0; i < len; i++) {
          const key = read(uint(start + i * refSize, refSize))
          if (typeof key === 'string') dict[key] = read(uint(start + (len + i) * refSize, refSize))
        }
        return dict
      }
      default:
        return null
    }
  }

  return read(top)
}
