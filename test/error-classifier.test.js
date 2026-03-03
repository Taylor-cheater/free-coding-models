import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyError, CircuitBreaker } from '../lib/error-classifier.js'

describe('classifyError', () => {
  it('classifies 429 as RATE_LIMITED', () => {
    const r = classifyError(429, '', {})
    assert.strictEqual(r.type, 'RATE_LIMITED')
  })

  it('classifies 429 with quota body as QUOTA_EXHAUSTED', () => {
    const r = classifyError(429, 'quota exceeded', {})
    assert.strictEqual(r.type, 'QUOTA_EXHAUSTED')
  })

  it('classifies 503 as MODEL_CAPACITY', () => {
    const r = classifyError(503, 'model overloaded', {})
    assert.strictEqual(r.type, 'MODEL_CAPACITY')
  })

  it('classifies 500 as SERVER_ERROR', () => {
    const r = classifyError(500, '', {})
    assert.strictEqual(r.type, 'SERVER_ERROR')
  })

  it('classifies 401 as AUTH_ERROR', () => {
    const r = classifyError(401, '', {})
    assert.strictEqual(r.type, 'AUTH_ERROR')
  })

  it('extracts retry-after from headers', () => {
    const r = classifyError(429, '', { 'retry-after': '30' })
    assert.strictEqual(r.retryAfterSec, 30)
  })

  it('classifies network/timeout errors', () => {
    const r = classifyError(0, 'ECONNREFUSED', {})
    assert.strictEqual(r.type, 'NETWORK_ERROR')
    assert.strictEqual(r.shouldRetry, true)
  })
})

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    assert.strictEqual(cb.isOpen(), false)
  })

  it('opens after N consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 60000 })
    cb.recordFailure()
    cb.recordFailure()
    assert.strictEqual(cb.isOpen(), false)
    cb.recordFailure()
    assert.strictEqual(cb.isOpen(), true)
  })

  it('resets on success', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 60000 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure() // only 1 now
    assert.strictEqual(cb.isOpen(), false)
  })

  it('transitions to half-open after cooldown', async () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 })
    cb.recordFailure()
    cb.recordFailure()
    assert.strictEqual(cb.isOpen(), true)
    await new Promise(r => setTimeout(r, 100))
    assert.strictEqual(cb.isOpen(), false) // half-open
    assert.strictEqual(cb.isHalfOpen(), true)
  })

  it('re-opens on failure in half-open', async () => {
    const cb = new CircuitBreaker({ threshold: 2, cooldownMs: 50 })
    cb.recordFailure()
    cb.recordFailure()
    await new Promise(r => setTimeout(r, 100))
    cb.isOpen() // triggers half-open transition
    cb.recordFailure() // fail during half-open
    assert.strictEqual(cb.isOpen(), true) // re-opened
  })
})
