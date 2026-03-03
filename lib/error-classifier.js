/**
 * Error types:
 * - QUOTA_EXHAUSTED: Skip account until quota resets
 * - RATE_LIMITED: Backoff, try another account
 * - MODEL_CAPACITY: Server overloaded, retry after delay
 * - SERVER_ERROR: Backoff, count toward circuit breaker
 * - AUTH_ERROR: Disable account permanently
 * - NETWORK_ERROR: Connection failure, try another
 * - UNKNOWN: Generic, no retry
 */
export const ErrorType = {
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_CAPACITY: 'MODEL_CAPACITY',
  SERVER_ERROR: 'SERVER_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN',
}

const QUOTA_KEYWORDS = ['quota', 'limit exceeded', 'billing', 'insufficient_quota', 'exceeded your']
const CAPACITY_KEYWORDS = ['overloaded', 'capacity', 'busy', 'unavailable']

/**
 * Classify an HTTP error response.
 * @param {number} statusCode - 0 for network errors
 * @param {string} body - Response body text or error message
 * @param {Object} headers - Response headers (lowercased keys)
 * @returns {{ type: string, retryAfterSec: number|null, shouldRetry: boolean, skipAccount: boolean }}
 */
export function classifyError(statusCode, body, headers) {
  const bodyLower = (body || '').toLowerCase()
  const retryAfter = headers?.['retry-after']
  const retryAfterSec = retryAfter ? parseInt(retryAfter, 10) || null : null

  // Network/connection errors
  if (statusCode === 0 || statusCode === undefined) {
    return { type: ErrorType.NETWORK_ERROR, retryAfterSec: 5, shouldRetry: true, skipAccount: false }
  }

  if (statusCode === 401 || statusCode === 403) {
    return { type: ErrorType.AUTH_ERROR, retryAfterSec: null, shouldRetry: false, skipAccount: true }
  }

  if (statusCode === 429) {
    const isQuota = QUOTA_KEYWORDS.some(kw => bodyLower.includes(kw))
    if (isQuota) {
      return { type: ErrorType.QUOTA_EXHAUSTED, retryAfterSec, shouldRetry: true, skipAccount: true }
    }
    return { type: ErrorType.RATE_LIMITED, retryAfterSec, shouldRetry: true, skipAccount: false }
  }

  if (statusCode === 503 || statusCode === 502) {
    return { type: ErrorType.MODEL_CAPACITY, retryAfterSec: retryAfterSec || 5, shouldRetry: true, skipAccount: false }
  }

  if (statusCode >= 500) {
    return { type: ErrorType.SERVER_ERROR, retryAfterSec: retryAfterSec || 10, shouldRetry: true, skipAccount: false }
  }

  return { type: ErrorType.UNKNOWN, retryAfterSec: null, shouldRetry: false, skipAccount: false }
}

/**
 * Circuit breaker: CLOSED → OPEN (after threshold failures) → HALF_OPEN (after cooldown) → CLOSED (on success) or → OPEN (on failure)
 */
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 60000 } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.consecutiveFailures = 0
    this.openedAt = null
    this.state = 'CLOSED'
  }

  recordFailure() {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= this.threshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN'
      this.openedAt = Date.now()
    }
  }

  recordSuccess() {
    this.consecutiveFailures = 0
    this.state = 'CLOSED'
    this.openedAt = null
  }

  isOpen() {
    if (this.state === 'CLOSED') return false
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN'
      return false
    }
    if (this.state === 'HALF_OPEN') return false
    return true
  }

  isHalfOpen() { return this.state === 'HALF_OPEN' }

  reset() {
    this.consecutiveFailures = 0
    this.state = 'CLOSED'
    this.openedAt = null
  }
}
