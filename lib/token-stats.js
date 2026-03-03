/**
 * @file lib/token-stats.js
 * @description Persistent token usage tracking for the multi-account proxy.
 *
 * Records per-account and per-model token usage, hourly/daily aggregates,
 * an in-memory ring buffer of the 100 most-recent requests, and an
 * append-only JSONL log file for detailed history.
 *
 * Storage locations:
 *   ~/.free-coding-models/token-stats.json  — aggregated stats (auto-saved every 10 records)
 *   ~/.free-coding-models/request-log.jsonl — timestamped per-request log (pruned after 30 days)
 *
 * @exports TokenStats
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DATA_DIR = join(homedir(), '.free-coding-models')
const STATS_FILE = join(DATA_DIR, 'token-stats.json')
const LOG_FILE = join(DATA_DIR, 'request-log.jsonl')
const MAX_RING_BUFFER = 100
const RETENTION_DAYS = 30

export class TokenStats {
  constructor() {
    this._stats = { byAccount: {}, byModel: {}, hourly: {}, daily: {} }
    this._ringBuffer = []
    this._recordsSinceLastSave = 0
    this._load()
    this._pruneOldLogs()
  }

  _load() {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      if (existsSync(STATS_FILE)) {
        this._stats = JSON.parse(readFileSync(STATS_FILE, 'utf8'))
      }
    } catch { /* start fresh */ }
  }

  _pruneOldLogs() {
    try {
      if (!existsSync(LOG_FILE)) return
      const cutoff = Date.now() - RETENTION_DAYS * 86400000
      const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
      const kept = lines.filter(line => {
        try { return JSON.parse(line).timestamp >= cutoff } catch { return false }
      })
      writeFileSync(LOG_FILE, kept.join('\n') + (kept.length ? '\n' : ''))
    } catch { /* ignore */ }
  }

  /**
   * Record a single request's token usage.
   *
   * @param {{ accountId: string, modelId: string, promptTokens?: number, completionTokens?: number, latencyMs?: number, success?: boolean }} entry
   */
  record(entry) {
    const {
      accountId,
      modelId,
      promptTokens = 0,
      completionTokens = 0,
      latencyMs = 0,
      success = true,
    } = entry
    const totalTokens = promptTokens + completionTokens
    const now = new Date()
    const hourKey = now.toISOString().slice(0, 13)
    const dayKey = now.toISOString().slice(0, 10)

    // By account
    const acct = this._stats.byAccount[accountId] ||= { requests: 0, tokens: 0, errors: 0 }
    acct.requests++
    acct.tokens += totalTokens
    if (!success) acct.errors++

    // By model
    const model = this._stats.byModel[modelId] ||= { requests: 0, tokens: 0 }
    model.requests++
    model.tokens += totalTokens

    // Hourly
    this._stats.hourly[hourKey] ||= { requests: 0, tokens: 0 }
    this._stats.hourly[hourKey].requests++
    this._stats.hourly[hourKey].tokens += totalTokens

    // Daily
    this._stats.daily[dayKey] ||= { requests: 0, tokens: 0 }
    this._stats.daily[dayKey].requests++
    this._stats.daily[dayKey].tokens += totalTokens

    // Ring buffer (newest at end)
    this._ringBuffer.push({ ...entry, timestamp: now.toISOString() })
    if (this._ringBuffer.length > MAX_RING_BUFFER) this._ringBuffer.shift()

    // JSONL log
    try {
      const logEntry = {
        timestamp: Date.now(),
        accountId,
        modelId,
        promptTokens,
        completionTokens,
        latencyMs,
        success,
      }
      appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n')
    } catch { /* ignore */ }

    // Auto-save every 10 records
    this._recordsSinceLastSave++
    if (this._recordsSinceLastSave >= 10) this.save()
  }

  save() {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(STATS_FILE, JSON.stringify(this._stats, null, 2))
      this._recordsSinceLastSave = 0
    } catch { /* ignore */ }
  }

  /**
   * Return a summary snapshot including the 10 most-recent requests.
   *
   * @returns {{ byAccount: object, byModel: object, hourly: object, daily: object, recentRequests: object[] }}
   */
  getSummary() {
    return {
      ...this._stats,
      recentRequests: this._ringBuffer.slice(-10),
    }
  }
}
