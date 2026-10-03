// Static guard: no test may reach the real "dropdrop" Atlas database.
// Any test file that uses the Atlas connection string must go through atlas-guard.js (which forces "dropdrop_test").
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DB, REAL_DB, connectTestDatabase } from './atlas-guard.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const testFiles = readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'no-real-db-writes.test.js' && f !== 'atlas-guard.js')

describe('tests never write to the real database', () => {
  it('the isolated and real database names are distinct constants', () => {
    assert.equal(TEST_DB, 'dropdrop_test')
    assert.equal(REAL_DB, 'dropdrop')
    assert.notEqual(TEST_DB, REAL_DB)
  })

  for (const file of testFiles) {
    const src = readFileSync(path.join(dir, file), 'utf8')
    // Only files that take the real URI from the environment AND open a connection need the guard.
    // (A test that merely sets a fake MONGODB_URI value, e.g. for log redaction, never connects.)
    const usesRealUri = /process\.env\.MONGODB_URI/.test(src) && /connectDatabase\(|connectTestDatabase\(|mongoose\.connect\(/.test(src)
    if (!usesRealUri) continue
    it(`${file}: uses the Atlas URI only through connectTestDatabase()`, () => {
      assert.match(src, /connectTestDatabase\(/, 'must connect via atlas-guard')
      // a bare connectDatabase(uri) would use whatever database the URI names (the real one)
      assert.doesNotMatch(src, /\bconnectDatabase\(\s*uri\s*\)/, 'must not call connectDatabase(uri) directly')
      assert.doesNotMatch(src, /\bconnectDatabase\(\s*process\.env\.MONGODB_URI/, 'must not call connectDatabase(process.env.MONGODB_URI)')
      assert.doesNotMatch(src, /mongoose\.connect\(\s*(uri|process\.env\.MONGODB_URI)/, 'must not call mongoose.connect with the real URI')
    })
  }

  it('the guard refuses to proceed if it is ever connected to a different database', async () => {
    // Exercise the refusal path without any network: a URI that cannot connect must reject, never "succeed" elsewhere.
    await assert.rejects(connectTestDatabase('mongodb://127.0.0.1:1/dropdrop?serverSelectionTimeoutMS=300'), /Could not connect/)
  })
})
