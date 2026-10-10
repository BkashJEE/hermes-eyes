// Checks that run without Hermes: the plugin's import contract, and the word
// detection that decides which words fly out whole and glow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('imports only what Hermes Desktop allows', () => {
  const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  const imported = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1])
  assert.ok(imported.length > 0)
  for (const mod of imported) assert.ok(allowed.has(mod), `unexpected import: ${mod}`)
})

test('has a default export with register()', () => {
  assert.match(src, /export default \{[\s\S]*register\(ctx\)/)
})

// The word scanner, lifted out of the plugin so it runs on its own.
function wordScanner() {
  const start = src.indexOf('const WORD_GAP')
  const end = src.indexOf('function tagText')
  assert.ok(start > 0 && end > start, 'word scanner section not found')
  const body = src.slice(start, end) + '\nreturn { scanWords, words, feed(t) { replyText += t } }'
  return new Function(body)()
}

test('picks files, paths, commands, links and numbers from a streamed reply', () => {
  const s = wordScanner()
  const reply =
    'Sure. I edited src/app.js and ~/.config/app/settings.conf, then ran `npm run build` which took 42s. ' +
    'See https://github.com/foo/bar. Coverage is 87.5% now, and/or 3 files. Version 2.1.0 is out on 10/09/2026. ' +
    'Done in 1.2s.\n```bash\ncd /tmp/x && make 99\n```\nAlso package.json changed. '
  const found = []
  for (let i = 0; i < reply.length; i += 5) {
    s.feed(reply.slice(i, i + 5))
    s.scanWords()
    while (s.words.length) found.push(s.words.shift().text)
  }
  assert.deepEqual(found, [
    'src/app.js',
    '~/.config/app/settings.conf',
    'npm run build',
    '42s',
    'https://github.com/foo/bar',
    '87.5%',
    '2.1.0',
    '1.2s',
    'package.json'
  ])
})
