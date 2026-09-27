// Builds Mac + Windows and publishes them as the GitHub release that installed copies update from.
//
//   npm version patch --no-git-tag-version
//   git commit -am "Release x.y.z" && git push
//   npm run release
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPO = 'itssotsot/tabs'

const run = (cmd, args, env) => execFileSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } })
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const fail = (message) => {
  console.error(`\n${message}\n`)
  process.exit(1)
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

// The tag is made from the pushed commit, so the release matches the code on GitHub.
const head = read('git', ['rev-parse', 'HEAD'])
const remote = read('git', ['ls-remote', 'origin', 'refs/heads/main']).split(/\s/)[0]
if (head !== remote) fail('Commit and push to main first, so the release is made from the code on GitHub.')

// One draft, made up front: the Mac and Windows uploads each create the release if it's missing,
// and doing that at the same moment fails. Apps don't see a draft until it's published below.
if (!existing) run('gh', ['release', 'create', tag, '-R', REPO, '--draft', '--title', version, '--target', head, '--notes', ''])

run('npx', ['electron-vite', 'build'])
run('npx', ['electron-builder', '--mac', '--win', '--publish', 'always'], { GH_TOKEN: read('gh', ['auth', 'token']) })
run('gh', ['release', 'edit', tag, '-R', REPO, '--draft=false', '--latest'])

console.log(`\nPublished ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
