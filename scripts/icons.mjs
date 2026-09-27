// Renders build/icon.svg into the app icons electron-builder picks up from build/:
//
//   npm run icons
//
//   icon.icns  macOS, 16–1024 px (via iconutil)
//   icon.ico   Windows, 16–256 px; cropped to the plate and without the drop shadow.
//              16 px comes from icon-16.svg, drawn on the pixel grid.
//   icon.png   1024 px, the macOS artwork
//
// Runs in Electron (not Node) so Chromium does the SVG rendering; no extra dependencies.
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const mac = readFileSync(join(build, 'icon.svg'), 'utf8')
const win = mac.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"').replace(' filter="url(#shadow)"', '')
const win16 = readFileSync(join(build, 'icon-16.svg'), 'utf8')

/** PNG buffers of `svg` at each size, rendered by Chromium. */
async function render(window, svg, sizes) {
  const urls = await window.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)}
    await img.decode()
    return ${JSON.stringify(sizes)}.map((size) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(img, 0, 0, size, size)
      return canvas.toDataURL('image/png')
    })
  })()`)
  return urls.map((url) => Buffer.from(url.split(',')[1], 'base64'))
}

/** An .ico holding PNG images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((i) => i.png)])
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('about:blank')

  const iconset = join(build, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset)
  const macSizes = [16, 32, 64, 128, 256, 512, 1024]
  const macPngs = await render(window, mac, macSizes)
  const bySize = new Map(macSizes.map((s, i) => [s, macPngs[i]]))
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), bySize.get(s))
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), bySize.get(s * 2))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'icon.icns')])
  rmSync(iconset, { recursive: true })
  writeFileSync(join(build, 'icon.png'), bySize.get(1024))

  const winSizes = [16, 20, 24, 32, 40, 48, 64, 256]
  const winPngs = [...(await render(window, win16, [16])), ...(await render(window, win, winSizes.slice(1)))]
  writeFileSync(join(build, 'icon.ico'), ico(winSizes.map((size, i) => ({ size, png: winPngs[i] }))))

  console.log('Wrote build/icon.icns, build/icon.ico and build/icon.png')
  app.quit()
})
