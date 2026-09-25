// Checks whether a newer castLabs (Widevine) build of Electron is available.
//
//   npm run check-electron              # report only
//   npm run check-electron -- --update  # install the newest castLabs build in the current major version
//
// castLabs rebuilds each official Electron release with Widevine, usually a little
// later. This compares what's installed with castLabs' newest build and with the
// newest official release, so you can see how far behind you are.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASTLABS_REPO = 'https://github.com/castlabs/electron-releases.git'
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

/** "44.1.0+wvcus" -> [44, 1, 0]; null for alphas/betas and anything unexpected. */
function parseStable(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(\+wvcus)?$/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const format = (v) => v.join('.')

function newest(versions, major) {
  const list = versions.filter((v) => major === undefined || v[0] === major).sort(compare)
  return list.at(-1) ?? null
}

function installedVersion() {
  const version = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version
  const parsed = parseStable(version)
  if (!parsed) throw new Error(`Unrecognised installed Electron version: ${version}`)
  return { raw: version, parsed, isCastLabs: version.includes('+wvcus') }
}

function castLabsVersions() {
  // git ls-remote needs no API token and isn't rate-limited like the GitHub API.
  const out = execFileSync('git', ['ls-remote', '--tags', CASTLABS_REPO], { encoding: 'utf8' })
  return [...out.matchAll(/refs\/tags\/(v[^\s^]+\+wvcus)$/gm)].map((m) => parseStable(m[1])).filter(Boolean)
}

async function officialVersions() {
  const res = await fetch('https://registry.npmjs.org/electron', { headers: { accept: 'application/vnd.npm.install-v1+json' } })
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`)
  const data = await res.json()
  return Object.keys(data.versions).map(parseStable).filter(Boolean)
}

function countBetween(versions, from, to) {
  return versions.filter((v) => compare(v, from) > 0 && compare(v, to) <= 0).length
}

function update(target) {
  const spec = `electron@github:castlabs/electron-releases#v${format(target)}+wvcus`
  console.log(`\nInstalling ${bold(spec)} …`)
  const env = { ...process.env }
  // Set by some host apps; it makes Electron's installer run as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  execFileSync('npm', ['install', '--save-dev', spec], { cwd: root, stdio: 'inherit', env })
  // Make sure the Electron binary itself is downloaded.
  execFileSync('node', ['node_modules/electron/install.js'], { cwd: root, stdio: 'inherit', env })
  console.log(green(`\nUpdated to ${format(target)}.`))
  console.log('Quit Browserr, then run `npm run app:mac` to rebuild the app with it.')
}

const current = installedVersion()
const [castLabs, official] = await Promise.all([castLabsVersions(), officialVersions()])
const major = current.parsed[0]

const castLabsSameMajor = newest(castLabs, major)
const castLabsLatest = newest(castLabs)
const officialSameMajor = newest(official, major)
const officialLatest = newest(official)

console.log(bold('Electron versions'))
console.log(`  Installed                   ${current.raw}${current.isCastLabs ? '' : yellow('  (official build: no Widevine)')}`)
console.log(`  castLabs newest ${major}.x        ${castLabsSameMajor ? format(castLabsSameMajor) + '+wvcus' : 'none'}`)
console.log(`  Official newest ${major}.x        ${officialSameMajor ? format(officialSameMajor) : 'none'}`)
console.log(`  castLabs newest overall     ${castLabsLatest ? format(castLabsLatest) + '+wvcus' : 'none'}`)
console.log(`  Official newest overall     ${officialLatest ? format(officialLatest) : 'none'}`)
console.log()

const canUpdate = castLabsSameMajor && compare(castLabsSameMajor, current.parsed) > 0
if (canUpdate) {
  console.log(yellow(`Update available: castLabs ${format(castLabsSameMajor)} (you have ${format(current.parsed)}).`))
} else {
  console.log(green(`You have the newest castLabs ${major}.x build.`))
}

if (officialSameMajor && castLabsSameMajor && compare(officialSameMajor, castLabsSameMajor) > 0) {
  const behind = countBetween(official, castLabsSameMajor, officialSameMajor)
  console.log(
    `castLabs is ${behind} official release${behind === 1 ? '' : 's'} behind (${format(officialSameMajor)}); ` +
      'those fixes arrive once castLabs publishes a new build.'
  )
}

if (castLabsLatest && castLabsLatest[0] > major) {
  console.log(
    `A newer major version is available from castLabs: ${format(castLabsLatest)}. ` +
      'Major upgrades can include breaking changes, so test before switching.'
  )
}

if (process.argv.includes('--update')) {
  if (canUpdate) update(castLabsSameMajor)
  else console.log('\nNothing to update.')
} else if (canUpdate) {
  console.log('\nRun `npm run check-electron -- --update` to install it.')
}
