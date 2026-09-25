// Widevine VMP signing with castLabs EVS (https://github.com/castlabs/electron-releases/wiki/EVS).
//
// Streaming services like Netflix only license Widevine to apps with a production
// VMP signature. castLabs signs apps for free once you have an EVS account:
//
//   python3 -m pip install --upgrade castlabs-evs
//   python3 -m castlabs_evs.account signup     # once
//   python3 -m castlabs_evs.account reauth     # when the session expires
//
// macOS must be VMP-signed before code signing (afterPack), Windows after (afterSign).
const { execFileSync } = require('node:child_process')

function evsAvailable() {
  try {
    execFileSync('python3', ['-c', 'import castlabs_evs'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function sign(context, stage) {
  const platform = context.electronPlatformName
  if ((platform === 'darwin' && stage !== 'afterPack') || (platform === 'win32' && stage !== 'afterSign')) return
  if (!evsAvailable()) {
    console.warn(
      '  • skipped Widevine VMP signing  reason=castlabs-evs not installed (DRM sites like Netflix will refuse to play; see build/vmp-sign.cjs)'
    )
    return
  }
  console.log(`  • VMP signing  appOutDir=${context.appOutDir}`)
  execFileSync('python3', ['-m', 'castlabs_evs.vmp', 'sign-pkg', context.appOutDir], { stdio: 'inherit' })
}

exports.afterPack = (context) => sign(context, 'afterPack')
exports.afterSign = (context) => sign(context, 'afterSign')
