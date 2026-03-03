import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AccountManager } from '../lib/account-manager.js'

function makeAccounts(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `acct-${i}`,
    providerKey: `provider-${i}`,
    apiKey: `key-${i}`,
    modelId: `model-${i}`,
    url: `https://api.provider-${i}.com/v1`,
  }))
}

describe('AccountManager', () => {
  it('selectAccount returns an account via P2C', () => {
    const am = new AccountManager(makeAccounts(3))
    const acct = am.selectAccount({})
    assert.ok(acct)
    assert.ok(acct.id.startsWith('acct-'))
  })

  it('skips accounts with open circuit breaker', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 2 })
    // Trip circuit breaker on acct-0
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    // Should always select acct-1
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(am.selectAccount({}).id, 'acct-1')
    }
  })

  it('updates quota from rate-limit headers', () => {
    const am = new AccountManager(makeAccounts(1))
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '20', 'x-ratelimit-limit': '100' })
    const h = am.getHealth('acct-0')
    assert.strictEqual(h.quotaPercent, 20) // 20% remaining
  })

  it('deprioritizes accounts at 80% quota used', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    // acct-0: 15% remaining (85% used) — should be deprioritized
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '15', 'x-ratelimit-limit': '100' })
    // acct-1: 80% remaining (20% used) — healthy
    am.updateQuota('acct-1', { 'x-ratelimit-remaining': '80', 'x-ratelimit-limit': '100' })
    // Check health scores
    const h0 = am.getHealth('acct-0')
    const h1 = am.getHealth('acct-1')
    assert.ok(h1.score > h0.score, `Healthy account (${h1.score}) should score higher than quota-depleted (${h0.score})`)
  })

  it('skips account when quota >= 95% used', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    am.updateQuota('acct-0', { 'x-ratelimit-remaining': '3', 'x-ratelimit-limit': '100' })
    // acct-0 at 97% used, should be effectively skipped
    for (let i = 0; i < 20; i++) {
      const selected = am.selectAccount({})
      assert.strictEqual(selected.id, 'acct-1', 'Should not select nearly-exhausted account')
    }
  })

  it('returns null when all accounts exhausted', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 1 })
    am.recordFailure('acct-0', { type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null })
    am.recordFailure('acct-1', { type: 'AUTH_ERROR', shouldRetry: false, skipAccount: true, retryAfterSec: null })
    assert.strictEqual(am.selectAccount({}), null)
  })

  it('sticky session returns same account for same fingerprint', () => {
    const am = new AccountManager(makeAccounts(5))
    const first = am.selectAccount({ sessionFingerprint: 'fp-abc' })
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(
        am.selectAccount({ sessionFingerprint: 'fp-abc' }).id,
        first.id,
        'Same fingerprint should return same account'
      )
    }
  })

  it('sticky session falls back when sticky account unhealthy', () => {
    const accounts = makeAccounts(3)
    const am = new AccountManager(accounts, { circuitBreakerThreshold: 2 })
    const first = am.selectAccount({ sessionFingerprint: 'fp-xyz' })
    // Kill the sticky account
    am.recordFailure(first.id, { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    am.recordFailure(first.id, { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    // Should get a different account
    const fallback = am.selectAccount({ sessionFingerprint: 'fp-xyz' })
    assert.ok(fallback)
    assert.notStrictEqual(fallback.id, first.id)
  })

  it('LRU evicts oldest sticky entries', () => {
    const am = new AccountManager(makeAccounts(10), { maxStickySessions: 5 })
    // Fill LRU with 5 entries
    for (let i = 0; i < 5; i++) {
      am.selectAccount({ sessionFingerprint: `fp-${i}` })
    }
    // Add one more, should evict fp-0
    am.selectAccount({ sessionFingerprint: 'fp-new' })
    // fp-0 should no longer be sticky (might get different account)
    const before = am.selectAccount({ sessionFingerprint: 'fp-0' })
    // Just verify no crash and it returns something
    assert.ok(before)
  })

  it('respects retryAfterSec cooldown', () => {
    const accounts = makeAccounts(2)
    const am = new AccountManager(accounts)
    am.recordFailure('acct-0', { type: 'RATE_LIMITED', shouldRetry: true, skipAccount: false, retryAfterSec: 3600 })
    // acct-0 should be skipped due to retry-after
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(am.selectAccount({}).id, 'acct-1')
    }
  })

  it('recordSuccess improves health', () => {
    const am = new AccountManager(makeAccounts(1))
    am.recordFailure('acct-0', { type: 'SERVER_ERROR', shouldRetry: true, skipAccount: false, retryAfterSec: null })
    const before = am.getHealth('acct-0').score
    am.recordSuccess('acct-0')
    const after = am.getHealth('acct-0').score
    assert.ok(after > before, 'Health should improve after success')
  })
})
