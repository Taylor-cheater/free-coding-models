import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const OC_CONFIG_DIR = join(homedir(), '.config', 'opencode')
const OC_CONFIG_PATH = join(OC_CONFIG_DIR, 'opencode.json')
const OC_BACKUP_PATH = join(OC_CONFIG_DIR, 'opencode.json.bak')

/**
 * Load existing OpenCode config, or return empty object.
 */
export function loadOpenCodeConfig() {
  try {
    if (existsSync(OC_CONFIG_PATH)) {
      return JSON.parse(readFileSync(OC_CONFIG_PATH, 'utf8'))
    }
  } catch {}
  return {}
}

/**
 * Save OpenCode config with automatic backup.
 * Creates backup of current config before overwriting.
 */
export function saveOpenCodeConfig(config) {
  mkdirSync(OC_CONFIG_DIR, { recursive: true })
  // Backup existing config before saving
  if (existsSync(OC_CONFIG_PATH)) {
    copyFileSync(OC_CONFIG_PATH, OC_BACKUP_PATH)
  }
  writeFileSync(OC_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/**
 * Restore OpenCode config from backup.
 * @returns {boolean} true if restored, false if no backup exists
 */
export function restoreOpenCodeBackup() {
  if (!existsSync(OC_BACKUP_PATH)) return false
  copyFileSync(OC_BACKUP_PATH, OC_CONFIG_PATH)
  return true
}

/**
 * MERGE FCM provider entries into OpenCode config.
 *
 * CRITICAL: This function ONLY adds/updates FCM-related provider entries.
 * It PRESERVES all existing providers (antigravity-manager, openai, iflow, etc.)
 * and all other top-level keys ($schema, mcp, plugin, command, model).
 *
 * @param {Object} fcmConfig - FCM config (from loadConfig())
 * @param {Object} sources - PROVIDERS object from sources.js
 * @param {Array} mergedModels - Output of buildMergedModels()
 * @param {{ useProxy: boolean, proxyPort?: number }} proxyInfo
 */
export function syncToOpenCode(fcmConfig, sources, mergedModels, proxyInfo) {
  const oc = loadOpenCodeConfig()
  oc.provider = oc.provider || {}

  if (proxyInfo.useProxy) {
    // Proxy mode: single fcm-proxy provider with all merged models
    const proxyBaseUrl = `http://127.0.0.1:${proxyInfo.proxyPort}/v1`
    const models = {}
    for (const m of mergedModels) {
      models[m.slug] = { name: m.label }
    }
    oc.provider['fcm-proxy'] = {
      npm: '@ai-sdk/openai-compatible',
      name: 'FCM Rotation Proxy',
      options: { baseURL: proxyBaseUrl, apiKey: 'fcm-proxy-key' },
      models,
    }
  } else {
    // Non-proxy mode: individual provider entries
    for (const [providerKey, source] of Object.entries(sources)) {
      const keys = fcmConfig?.apiKeys?.[providerKey]
      if (!keys) continue  // skip providers without keys

      const apiKey = Array.isArray(keys) ? keys[0] : keys
      if (!apiKey) continue

      let baseURL = source.url
      // Handle Cloudflare account_id placeholder
      if (baseURL.includes('{account_id}') && fcmConfig.cloudflareAccountId) {
        baseURL = baseURL.replace('{account_id}', fcmConfig.cloudflareAccountId)
      }
      // Strip trailing /chat/completions if present (OpenCode adds it)
      baseURL = baseURL.replace(/\/chat\/completions\/?$/, '')

      // Build models for this provider
      const models = {}
      for (const m of mergedModels) {
        for (const p of m.providers) {
          if (p.providerKey === providerKey) {
            models[p.modelId] = { name: m.label }
          }
        }
      }

      if (Object.keys(models).length === 0) continue

      oc.provider[providerKey] = {
        npm: '@ai-sdk/openai-compatible',
        name: source.name,
        options: { baseURL, apiKey },
        models,
      }
    }
  }

  saveOpenCodeConfig(oc)
  return { providersAdded: Object.keys(oc.provider).length, path: OC_CONFIG_PATH }
}
