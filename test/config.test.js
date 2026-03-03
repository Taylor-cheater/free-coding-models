import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiKeys, normalizeApiKeyConfig } from '../lib/config.js'

describe('resolveApiKeys', () => {
  it('returns single key as array', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc'])
  })

  it('returns array as-is', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc', 'gsk_def'])
  })

  it('returns empty array when no key', () => {
    const config = { apiKeys: {} }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), [])
  })

  it('resolves env var fallback', () => {
    process.env.TEST_FCM_KEY_XYZ = 'from-env'
    const config = { apiKeys: {} }
    const keys = resolveApiKeys(config, 'groq', 'TEST_FCM_KEY_XYZ')
    assert.deepStrictEqual(keys, ['from-env'])
    delete process.env.TEST_FCM_KEY_XYZ
  })

  it('filters empty strings', () => {
    const config = { apiKeys: { groq: ['gsk_abc', '', 'gsk_def'] } }
    assert.deepStrictEqual(resolveApiKeys(config, 'groq'), ['gsk_abc', 'gsk_def'])
  })
})

describe('normalizeApiKeyConfig', () => {
  it('does not convert single key to array on disk', () => {
    const config = { apiKeys: { groq: 'gsk_abc' } }
    normalizeApiKeyConfig(config)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('collapses single-element array to string', () => {
    const config = { apiKeys: { groq: ['gsk_abc'] } }
    normalizeApiKeyConfig(config)
    assert.strictEqual(config.apiKeys.groq, 'gsk_abc')
  })

  it('keeps array when multiple keys', () => {
    const config = { apiKeys: { groq: ['gsk_abc', 'gsk_def'] } }
    normalizeApiKeyConfig(config)
    assert.deepStrictEqual(config.apiKeys.groq, ['gsk_abc', 'gsk_def'])
  })
})
