// Dev helper: evaluate JS in one of the app's webContents over CDP.
// Usage: node scripts/cdp.mjs <url-substring> "<expression>"
const port = process.env.BROWSERR_DEBUG_PORT ?? '9333'
const [match, expression] = process.argv.slice(2)
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
if (!expression) {
  for (const t of targets) console.log(t.type.padEnd(8), t.url)
  process.exit(0)
}
const target = targets.find((t) => t.url.includes(match))
if (!target) throw new Error(`No target matching ${match}`)
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id !== 1) return
  console.log(JSON.stringify(msg.result?.result?.value ?? msg.result?.exceptionDetails ?? msg, null, 2))
  ws.close()
})
