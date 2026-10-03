import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BACKEND_DIR } from '../support/backend'
import { LANGUAGES, ROOM_CONTENT_MAX, ROOM_NAME_MAX, ROOM_NAME_PATTERN, randomRoomName, validateRoomName } from '../../utils/validation'

const read = (p: string) => readFileSync(p, 'utf8')
const webRoom = read(path.join(BACKEND_DIR, '..', 'frontend', 'src', 'lib', 'room.js'))
const webLangs = read(path.join(BACKEND_DIR, '..', 'frontend', 'src', 'lib', 'languages.js'))
const apiRules = read(path.join(BACKEND_DIR, 'src', 'utils', 'validation.js'))

describe('room validation (3. Room validation)', () => {
  it('accepts valid names', () => {
    for (const n of ['a', 'demo-room', 'team-notes', 'under_score', 'A1', 'x'.repeat(64), '9lives']) assert.equal(validateRoomName(n), null, n)
  })
  it('rejects invalid names with a helpful message', () => {
    for (const n of ['', ' ', 'bad name', '-lead', '_lead', 'dot.dot', 'semi;colon', 'ünï', 'a/b', 'x'.repeat(65), undefined, null]) {
      const msg = validateRoomName(n as string)
      assert.ok(msg && msg.length > 5, `${JSON.stringify(n)} should be rejected`)
    }
  })
  it('random room names are always valid', () => {
    for (let i = 0; i < 500; i++) assert.equal(validateRoomName(randomRoomName()), null)
  })
})

describe('rules are identical to the website and the backend (no drift)', () => {
  const regexOf = (src: string) => /ROOM_NAME_PATTERN\s*=\s*\/(.+)\/\s*$/m.exec(src)![1]
  const numberOf = (src: string, name: string) => Number(new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(src)![1].replace(/_/g, ''))

  it('name pattern', () => {
    assert.equal(regexOf(webRoom), ROOM_NAME_PATTERN.source)
    assert.equal(regexOf(apiRules), ROOM_NAME_PATTERN.source)
  })
  it('max name length', () => {
    assert.equal(numberOf(webRoom, 'ROOM_NAME_MAX'), ROOM_NAME_MAX)
    assert.equal(numberOf(apiRules, 'ROOM_NAME_MAX'), ROOM_NAME_MAX)
  })
  it('content limit', () => {
    assert.equal(numberOf(webRoom, 'ROOM_CONTENT_MAX'), ROOM_CONTENT_MAX)
    assert.equal(numberOf(apiRules, 'MAX_CONTENT_LENGTH'), ROOM_CONTENT_MAX)
  })
  it('language ids', () => {
    const web = [...webLangs.matchAll(/id: '([a-z+]+)'/g)].map((m) => m[1])
    assert.deepEqual(LANGUAGES.map((l) => l.id), web)
    const api = /LANGUAGES = \[([^\]]+)\]/.exec(apiRules)![1].match(/'([a-z]+)'/g)!.map((s) => s.replace(/'/g, ''))
    assert.deepEqual(LANGUAGES.map((l) => l.id), api)
  })
})
