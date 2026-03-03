/**
 * @file lib/account-manager.js
 * @description Multi-account health tracking and selection for proxy rotation.
 *
 * Tracks per-account health (success rate, latency, quota) and uses
 * Power-of-2-Choices (P2C) to select the best available account.
 * Supports sticky sessions via an LRU map, circuit breakers per account,
 * and retry-after cooldown periods.
 *
 * @exports AccountManager
 */

import { CircuitBreaker } from './error-classifier.js'

// ─── Internal: per-account health state ──────────────────────────────────────

class AccountHealth {
  /**
   * @param {number} cbThreshold - Circuit breaker failure threshold
   * @param {number} cbCooldownMs - Circuit breaker cooldown in ms
   */
  constructor(cbThreshold, cbCooldownMs) {
    this.successCount = 0
    this.failureCount = 0
    this.totalLatencyMs = 0
    /** Remaining quota as a percentage 0–100. Default 100 (fully available). */
    this.quotaPercent = 100
    /** When true, this account is permanently disabled (e.g. auth failure). */
    this.disabled = false
    this.circuitBreaker = new CircuitBreaker({
      threshold: cbThreshold,
      cooldownMs: cbCooldownMs,
    })
  }

  /**
   * Health score in roughly [0, 1].
   *
   * Formula:
   *   0.4 * successRate + 0.3 * latencyScore + 0.3 * quotaScore − penalty
   *
   * Where:
   *   successRate  = successes / (successes + failures), default 1.0 if no requests
   *   latencyScore = 1 − min(avgLatencyMs / 5000, 1)   (lower = better)
   *   quotaScore   = quotaPercent / 100                 (more remaining = better)
   *   penalty      = 0.5 if quotaPercent < 20%
   *                = 0.3 if quotaPercent < 35%
   *                = 0   otherwise
   *
   * @returns {number}
   */
  computeScore() {
    const total = this.successCount + this.failureCount
    const successRate = total === 0 ? 1.0 : this.successCount / total
    const avgLatencyMs = total === 0 ? 0 : this.totalLatencyMs / total
    const latencyScore = 1 - Math.min(avgLatencyMs / 5000, 1)
    const quotaScore = this.quotaPercent / 100

    let penalty = 0
    if (this.quotaPercent < 20) penalty = 0.5
    else if (this.quotaPercent < 35) penalty = 0.3

    return 0.4 * successRate + 0.3 * latencyScore + 0.3 * quotaScore - penalty
  }
}

// ─── LRU Map helper ───────────────────────────────────────────────────────────
// Uses plain Map (insertion-ordered). To access: delete then re-set (moves to end).
// To insert new: evict first key if at capacity.

/**
 * Read from LRU map, moving the entry to "most recently used" position.
 * Returns undefined if key is absent.
 *
 * @param {Map<string, string>} map
 * @param {string} key
 * @returns {string|undefined}
 */
function lruGet(map, key) {
  if (!map.has(key)) return undefined
  const val = map.get(key)
  map.delete(key)
  map.set(key, val)
  return val
}

/**
 * Write to LRU map. If the key already exists, move it to the end.
 * If the map is at capacity (and key is new), evict the oldest entry first.
 *
 * @param {Map<string, string>} map
 * @param {string} key
 * @param {string} value
 * @param {number} maxSize
 */
function lruSet(map, key, value, maxSize) {
  if (map.has(key)) {
    // Update value and move to end
    map.delete(key)
  } else if (map.size >= maxSize) {
    // Evict oldest (first) entry
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
  map.set(key, value)
}

// ─── AccountManager ───────────────────────────────────────────────────────────

export class AccountManager {
  /**
   * @param {Array<{ id: string, providerKey: string, apiKey: string, modelId: string, url: string }>} accounts
   * @param {{ circuitBreakerThreshold?: number, circuitBreakerCooldownMs?: number, maxStickySessions?: number }} [opts]
   */
  constructor(accounts, opts = {}) {
    const {
      circuitBreakerThreshold = 5,
      circuitBreakerCooldownMs = 60000,
      maxStickySessions = 1000,
    } = opts

    this._accounts = accounts
    this._maxStickySessions = maxStickySessions

    /** @type {Map<string, AccountHealth>} */
    this._healthMap = new Map()
    for (const acct of accounts) {
      this._healthMap.set(
        acct.id,
        new AccountHealth(circuitBreakerThreshold, circuitBreakerCooldownMs)
      )
    }

    /** LRU Map: fingerprint → accountId */
    this._stickyMap = new Map()

    /** Map: accountId → retryAfter epoch ms */
    this._retryAfterMap = new Map()
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns true if the account can currently accept requests.
   * Checks: not disabled, circuit breaker not open, not in retry-after cooldown,
   * and quota > 5% remaining.
   *
   * @param {{ id: string }} acct
   * @returns {boolean}
   */
  _isAccountAvailable(acct) {
    const health = this._healthMap.get(acct.id)
    if (!health) return false
    if (health.disabled) return false
    if (health.circuitBreaker.isOpen()) return false

    const retryAfterTs = this._retryAfterMap.get(acct.id)
    if (retryAfterTs && Date.now() < retryAfterTs) return false

    if (health.quotaPercent <= 5) return false

    return true
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Select the best available account.
   *
   * Algorithm:
   * 1. If `sessionFingerprint` is set and a sticky entry exists for it,
   *    return the sticky account if it is healthy. Otherwise fall through.
   * 2. Filter all accounts to those that are currently available.
   * 3. If none available, return null.
   * 4. Power-of-2-Choices (P2C): sample 2 random candidates, return the
   *    one with the higher health score. (If only 1 available, return it.)
   * 5. If `sessionFingerprint` is set, store the selection in the LRU map.
   *
   * @param {{ sessionFingerprint?: string }} [opts]
   * @returns {{ id: string, providerKey: string, apiKey: string, modelId: string, url: string } | null}
   */
  selectAccount({ sessionFingerprint } = {}) {
    // 1. Sticky session fast-path
    if (sessionFingerprint) {
      const stickyId = lruGet(this._stickyMap, sessionFingerprint)
      if (stickyId !== undefined) {
        const stickyAcct = this._accounts.find(a => a.id === stickyId)
        if (stickyAcct && this._isAccountAvailable(stickyAcct)) {
          return stickyAcct
        }
        // Sticky account is unhealthy — fall through to P2C
      }
    }

    // 2. Filter to available accounts
    const available = this._accounts.filter(a => this._isAccountAvailable(a))
    if (available.length === 0) return null

    // 3. P2C selection
    let selected
    if (available.length === 1) {
      selected = available[0]
    } else {
      // Pick two distinct random indices
      const idx1 = Math.floor(Math.random() * available.length)
      let idx2 = Math.floor(Math.random() * (available.length - 1))
      if (idx2 >= idx1) idx2++

      const a = available[idx1]
      const b = available[idx2]
      const scoreA = this._healthMap.get(a.id).computeScore()
      const scoreB = this._healthMap.get(b.id).computeScore()
      selected = scoreA >= scoreB ? a : b
    }

    // 4. Store/update sticky entry
    if (sessionFingerprint) {
      lruSet(this._stickyMap, sessionFingerprint, selected.id, this._maxStickySessions)
    }

    return selected
  }

  /**
   * Update an account's remaining quota from rate-limit response headers.
   * Reads `x-ratelimit-remaining` and `x-ratelimit-limit`.
   *
   * @param {string} accountId
   * @param {Record<string, string>} headers - Lowercased response headers
   */
  updateQuota(accountId, headers) {
    const remaining = parseInt(headers?.['x-ratelimit-remaining'], 10)
    const limit = parseInt(headers?.['x-ratelimit-limit'], 10)
    if (!isNaN(remaining) && !isNaN(limit) && limit > 0) {
      const health = this._healthMap.get(accountId)
      if (health) {
        health.quotaPercent = Math.round((remaining / limit) * 100)
      }
    }
  }

  /**
   * Record a failed request against an account.
   *
   * - Increments failure count
   * - Ticks the circuit breaker
   * - If `classifiedError.skipAccount` is true, disables the account permanently
   * - If `classifiedError.retryAfterSec` is set, marks the account as cooling down
   *
   * @param {string} accountId
   * @param {{ type: string, shouldRetry: boolean, skipAccount: boolean, retryAfterSec: number|null }} classifiedError
   */
  recordFailure(accountId, classifiedError) {
    const health = this._healthMap.get(accountId)
    if (!health) return

    health.failureCount++
    health.circuitBreaker.recordFailure()

    if (classifiedError?.skipAccount) {
      health.disabled = true
    }

    if (classifiedError?.retryAfterSec) {
      this._retryAfterMap.set(accountId, Date.now() + classifiedError.retryAfterSec * 1000)
    }
  }

  /**
   * Record a successful request against an account.
   *
   * @param {string} accountId
   * @param {number} [latencyMs] - Round-trip time in milliseconds (optional)
   */
  recordSuccess(accountId, latencyMs = 0) {
    const health = this._healthMap.get(accountId)
    if (!health) return

    health.successCount++
    health.totalLatencyMs += latencyMs
    health.circuitBreaker.recordSuccess()
  }

  /**
   * Get the current health snapshot for an account.
   *
   * @param {string} accountId
   * @returns {{ score: number, quotaPercent: number } | null}
   */
  getHealth(accountId) {
    const health = this._healthMap.get(accountId)
    if (!health) return null
    return {
      score: health.computeScore(),
      quotaPercent: health.quotaPercent,
    }
  }

  /**
   * Get the remaining retry-after cooldown for an account in seconds.
   * Returns 0 if no cooldown is active.
   *
   * @param {string} accountId
   * @returns {number}
   */
  getRetryAfter(accountId) {
    const retryAfterTs = this._retryAfterMap.get(accountId)
    if (!retryAfterTs) return 0
    return Math.max(0, (retryAfterTs - Date.now()) / 1000)
  }
}
