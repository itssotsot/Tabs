// Builds Mac + Windows and publishes them as the GitHub release that installed copies update from.
//
//   npm version patch --no-git-tag-version
//   git commit -am "Release x.y.z" && git push
//   npm run release
import { execFileSync, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

const REPO = 'itssotsot/Tabs'
// The Mac updater only installs apps signed by the same team as the running one (src/main/updater.ts).
// electron-builder.yml picks the certificate (mac.identity); this checks it's this team's.
const MAC_TEAM = 'P8MQ267KS3' // Sotiris Kaniras, the personal Apple ID
const RENEW = 'Create one for free in Xcode › Settings › Accounts › (your Apple ID) › Manage Certificates › + › Apple Development.'

const run = (cmd, args, env) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
}

/** The team of the valid signing certificate electron-builder.yml names, or why there's none. */
function signingTeam() {
  const identity = readFileSync('electron-builder.yml', 'utf8').match(/^\s+identity:\s*(.+?)\s*$/m)?.[1]
  if (!identity) return { error: 'electron-builder.yml has no mac.identity.' }
  const valid = [...read('security', ['find-identity', '-v', '-p', 'codesigning']).matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"$/gm)]
  const match = valid.find(([, , name]) => name.includes(identity))
  if (!match) return { error: `No valid signing certificate for ${identity} (it may have expired). ${RENEW}` }
  const pems = read('security', ['find-certificate', '-a', '-p', '-c', identity]).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  const cert = pems.map((pem) => new X509Certificate(pem)).find((c) => c.fingerprint.replaceAll(':', '') === match[1])
  const team = cert?.subject.match(/^OU=(.+)$/m)?.[1]
  return { team, name: match[2], expires: cert?.validTo }
}

/** The team a built app is signed by (codesign prints it on stderr). */
function appTeam(path) {
  const { stderr } = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8' })
  return stderr?.match(/^TeamIdentifier=(.+)$/m)?.[1] ?? null
}

/** The version's section of CHANGELOG.md (its "- " items), or null if it has none. */
function releaseNotes(version) {
  const markdown = readFileSync('CHANGELOG.md', 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  const heading = new RegExp(`^##\\s+${version.replaceAll('.', '\\.')}\\s*$`, 'm').exec(markdown)
  if (!heading) return null
  const rest = markdown.slice(heading.index + heading[0].length)
  const end = rest.search(/^##\s/m)
  return (end === -1 ? rest : rest.slice(0, end)).trim() || null
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`

let existing = null
try {
  existing = JSON.parse(read('gh', ['release', 'view', tag, '-R', REPO, '--json', 'isDraft']))
} catch {
  // No release with this tag yet.
}
if (existing && !existing.isDraft) fail(`${tag} is already released. Bump the version first: npm version patch --no-git-tag-version`)

// The app shows its own version's notes after updating, so every release needs them.
const notes = releaseNotes(version)
if (!notes) fail(`CHANGELOG.md has no "## ${version}" section. Add what changed (short "- " items, written for friends), commit and push.`)

// The tag is made from the pushed commit, so the release matches the code on GitHub.
const head = read('git', ['rev-parse', 'HEAD'])
const remote = read('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0]
if (head !== remote) fail('Commit and push to main first, so the release is made from the code on GitHub.')

const signing = signingTeam()
if (signing.error) fail(signing.error)
if (signing.team !== MAC_TEAM) fail(`${signing.name} is team ${signing.team}, not ${MAC_TEAM}. Mac updates only install from one team.`)
console.log(`Signing with ${signing.name} (team ${signing.team}, valid until ${signing.expires})`)

// One draft, made up front: the Mac and Windows uploads each create the release if it's missing,
// and doing that at the same moment fails. Apps don't see a draft until it's published below.
if (existing) run('gh', ['release', 'edit', tag, '-R', REPO, '--notes', notes])
else run('gh', ['release', 'create', tag, '-R', REPO, '--draft', '--title', version, '--target', head, '--notes', notes])

run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--mac', '--win', '--publish', 'always'], { GH_TOKEN: read('gh', ['auth', 'token']) })
// The draft isn't public yet, so a wrongly signed build goes nowhere.
const team = appTeam('dist/mac-arm64/Tabs.app')
if (team !== MAC_TEAM) fail(`The Mac build is signed by team ${team ?? 'none'}, not ${MAC_TEAM}, so installed copies wouldn't install it. The draft ${tag} wasn't published.`)

run('gh', ['release', 'edit', tag, '-R', REPO, '--draft=false', '--latest'])

console.log(`\nPublished ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
