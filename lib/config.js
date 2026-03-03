/**
 * @file lib/config.js
 * @description JSON config management for free-coding-models multi-provider support.
 *
 * 📖 This module manages ~/.free-coding-models.json, the new config file that
 *    stores API keys and per-provider enabled/disabled state for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.).
 *
 * 📖 Config file location: ~/.free-coding-models.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "sambanova":  "sn-xxx",
 *       "openrouter": "sk-or-xxx",
 *       "huggingface":"hf_xxx",
 *       "replicate":  "r8_xxx",
 *       "deepinfra":  "di_xxx",
 *       "fireworks":  "fw_xxx",
 *       "codestral":  "csk-xxx",
 *       "hyperbolic": "eyJ...",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza...",
 *       "siliconflow":"sk-xxx",
 *       "together":   "together-xxx",
 *       "cloudflare": "cf-xxx",
 *       "perplexity": "pplx-xxx",
 *       "zai":        "zai-xxx"
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "sambanova":  { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "huggingface":{ "enabled": true },
 *       "replicate":  { "enabled": true },
 *       "deepinfra":  { "enabled": true },
 *       "fireworks":  { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "hyperbolic": { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true },
 *       "siliconflow":{ "enabled": true },
 *       "together":   { "enabled": true },
 *       "cloudflare": { "enabled": true },
 *       "perplexity": { "enabled": true },
 *       "zai":        { "enabled": true }
 *     },
 *     "favorites": [
 *       "nvidia/deepseek-ai/deepseek-v3.2"
 *     ],
 *     "telemetry": {
 *       "enabled": true,
 *       "consentVersion": 1,
 *       "anonymousId": "anon_550e8400-e29b-41d4-a716-446655440000"
 *     },
 *     "activeProfile": "work",
 *     "profiles": {
 *       "work":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "personal": { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} },
 *       "fast":     { "apiKeys": {...}, "providers": {...}, "favorites": [...], "settings": {...} }
 *     }
 *   }
 *
 * 📖 Profiles store a snapshot of the user's configuration. Each profile contains:
 *   - apiKeys: API keys per provider (can differ between work/personal setups)
 *   - providers: enabled/disabled state per provider
 *   - favorites: list of pinned favorite models
 *   - settings: extra TUI preferences (tierFilter, sortColumn, sortAsc, pingInterval)
 *
 * 📖 When a profile is loaded via --profile <name> or Shift+P, the main config's
 *    apiKeys/providers/favorites are replaced with the profile's values. The profile
 *    data itself stays in the profiles section — it's a named snapshot, not a fork.
 *
 * 📖 Migration: On first run, if the old plain-text ~/.free-coding-models exists
 *    and the new JSON file does not, the old key is auto-migrated as the nvidia key.
 *    The old file is left in place (not deleted) for safety.
 *
 * @functions
 *   → loadConfig() — Read ~/.free-coding-models.json; auto-migrate old plain-text config if needed
 *   → saveConfig(config) — Write config to ~/.free-coding-models.json with 0o600 permissions
 *   → getApiKey(config, providerKey) — Get effective API key (env var override > config > null)
 *   → isProviderEnabled(config, providerKey) — Check if provider is enabled (defaults true)
 *   → saveAsProfile(config, name) — Snapshot current apiKeys/providers/favorites/settings into a named profile
 *   → loadProfile(config, name) — Apply a named profile's values onto the live config
 *   → listProfiles(config) — Return array of profile names
 *   → deleteProfile(config, name) — Remove a named profile
 *   → getActiveProfileName(config) — Get the currently active profile name (or null)
 *   → setActiveProfile(config, name) — Set which profile is active (null to clear)
 *   → _emptyProfileSettings() — Default TUI settings for a profile
 *
 * @exports loadConfig, saveConfig, getApiKey, isProviderEnabled
 * @exports saveAsProfile, loadProfile, listProfiles, deleteProfile
 * @exports getActiveProfileName, setActiveProfile
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/free-coding-models.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// 📖 New JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.free-coding-models.json')

// 📖 Old plain-text config path — used only for migration
const LEGACY_CONFIG_PATH = join(homedir(), '.free-coding-models')

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia:     'NVIDIA_API_KEY',
  groq:       'GROQ_API_KEY',
  cerebras:   'CEREBRAS_API_KEY',
  sambanova:  'SAMBANOVA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  huggingface:['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
  replicate:  'REPLICATE_API_TOKEN',
  deepinfra:  ['DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN'],
  fireworks:  'FIREWORKS_API_KEY',
  codestral:  'CODESTRAL_API_KEY',
  hyperbolic: 'HYPERBOLIC_API_KEY',
  scaleway:   'SCALEWAY_API_KEY',
  googleai:   'GOOGLE_API_KEY',
  siliconflow:'SILICONFLOW_API_KEY',
  together:   'TOGETHER_API_KEY',
  cloudflare: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'],
  perplexity: ['PERPLEXITY_API_KEY', 'PPLX_API_KEY'],
  qwen:       'DASHSCOPE_API_KEY',
  zai:        'ZAI_API_KEY',
  iflow:      'IFLOW_API_KEY',
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.free-coding-models.json (new format)
 *   2. If missing, check if ~/.free-coding-models (old plain-text) exists → migrate
 *   3. If neither, return an empty default config
 *
 * 📖 The migration reads the old file as a plain nvidia API key and writes
 *    a proper JSON config. The old file is NOT deleted (safety first).
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites: string[], telemetry: { enabled: boolean | null, consentVersion: number, anonymousId: string | null } }}
 */
export function loadConfig() {
  // 📖 Try new JSON config first
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8').trim()
      const parsed = JSON.parse(raw)
      // 📖 Ensure the shape is always complete — fill missing sections with defaults
      if (!parsed.apiKeys) parsed.apiKeys = {}
      if (!parsed.providers) parsed.providers = {}
      // 📖 Favorites: list of "providerKey/modelId" pinned rows.
      if (!Array.isArray(parsed.favorites)) parsed.favorites = []
      parsed.favorites = parsed.favorites.filter((fav) => typeof fav === 'string' && fav.trim().length > 0)
      if (!parsed.telemetry || typeof parsed.telemetry !== 'object') parsed.telemetry = { enabled: null, consentVersion: 0, anonymousId: null }
      if (typeof parsed.telemetry.enabled !== 'boolean') parsed.telemetry.enabled = null
      if (typeof parsed.telemetry.consentVersion !== 'number') parsed.telemetry.consentVersion = 0
      if (typeof parsed.telemetry.anonymousId !== 'string' || !parsed.telemetry.anonymousId.trim()) parsed.telemetry.anonymousId = null
      // 📖 Ensure profiles section exists (added in profile system)
      if (!parsed.profiles || typeof parsed.profiles !== 'object') parsed.profiles = {}
      if (parsed.activeProfile && typeof parsed.activeProfile !== 'string') parsed.activeProfile = null
      return parsed
    } catch {
      // 📖 Corrupted JSON — return empty config (user will re-enter keys)
      return _emptyConfig()
    }
  }

  // 📖 Migration path: old plain-text file exists, new JSON doesn't
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const oldKey = readFileSync(LEGACY_CONFIG_PATH, 'utf8').trim()
      if (oldKey) {
        const config = _emptyConfig()
        config.apiKeys.nvidia = oldKey
        // 📖 Auto-save migrated config so next launch is fast
        saveConfig(config)
        return config
      }
    } catch {
      // 📖 Can't read old file — proceed with empty config
    }
  }

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.free-coding-models.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, favorites?: string[], telemetry?: { enabled?: boolean | null, consentVersion?: number, anonymousId?: string | null } }} config
 */
export function saveConfig(config) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch {
    // 📖 Silently fail — the app is still usable, keys just won't persist
  }
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.free-coding-models.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey]
  const envCandidates = Array.isArray(envVar) ? envVar : [envVar]
  for (const candidate of envCandidates) {
    if (candidate && process.env[candidate]) return process.env[candidate]
  }

  // 📖 Config file value
  const key = config?.apiKeys?.[providerKey]
  if (key) return key

  return null
}

/**
 * Resolve all API keys for a provider as an array.
 * Handles: string → [string], string[] → string[], missing → []
 * Filters empty strings. Falls back to envVarName if no config key.
 */
export function resolveApiKeys(config, providerKey, envVarName) {
  const raw = config?.apiKeys?.[providerKey]
  let keys = []
  if (Array.isArray(raw)) {
    keys = raw
  } else if (typeof raw === 'string' && raw.length > 0) {
    keys = [raw]
  } else if (envVarName && process.env[envVarName]) {
    keys = [process.env[envVarName]]
  }
  return keys.filter(k => typeof k === 'string' && k.length > 0)
}

/**
 * Normalize config for disk persistence.
 * Single-element arrays collapse to string. Multi-element arrays stay.
 */
export function normalizeApiKeyConfig(config) {
  if (!config?.apiKeys) return
  for (const [key, val] of Object.entries(config.apiKeys)) {
    if (Array.isArray(val) && val.length === 1) {
      config.apiKeys[key] = val[0]
    }
  }
}

/**
 * 📖 isProviderEnabled: Check if a provider is enabled in config.
 *
 * 📖 Providers are enabled by default if not explicitly set to false.
 * 📖 A provider without an API key should still appear in settings (just can't ping).
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return true // 📖 Default: enabled
  return providerConfig.enabled !== false
}

// ─── Config Profiles ──────────────────────────────────────────────────────────

/**
 * 📖 _emptyProfileSettings: Default TUI settings stored in a profile.
 *
 * 📖 These settings are saved/restored when switching profiles so each profile
 *    can have different sort, filter, and ping preferences.
 *
 * @returns {{ tierFilter: string|null, sortColumn: string, sortAsc: boolean, pingInterval: number }}
 */
export function _emptyProfileSettings() {
  return {
    tierFilter: null,     // 📖 null = show all tiers, or 'S'|'A'|'B'|'C'|'D'
    sortColumn: 'avg',    // 📖 default sort column
    sortAsc: true,        // 📖 true = ascending (fastest first for latency)
    pingInterval: 8000,   // 📖 default ms between pings
  }
}

/**
 * 📖 saveAsProfile: Snapshot the current config state into a named profile.
 *
 * 📖 Takes the current apiKeys, providers, favorites, plus explicit TUI settings
 *    and stores them under config.profiles[name]. Does NOT change activeProfile —
 *    call setActiveProfile() separately if you want to switch to this profile.
 *
 * 📖 If a profile with the same name exists, it's overwritten.
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} name — Profile name (e.g. 'work', 'personal', 'fast')
 * @param {object} [settings] — TUI settings to save (tierFilter, sortColumn, etc.)
 * @returns {object} The config object (for chaining)
 */
export function saveAsProfile(config, name, settings = null) {
  if (!config.profiles || typeof config.profiles !== 'object') config.profiles = {}
  config.profiles[name] = {
    apiKeys: JSON.parse(JSON.stringify(config.apiKeys || {})),
    providers: JSON.parse(JSON.stringify(config.providers || {})),
    favorites: [...(config.favorites || [])],
    settings: settings ? { ..._emptyProfileSettings(), ...settings } : _emptyProfileSettings(),
  }
  return config
}

/**
 * 📖 loadProfile: Apply a named profile's values onto the live config.
 *
 * 📖 Replaces config.apiKeys, config.providers, config.favorites with the
 *    profile's stored values. Also sets config.activeProfile to the loaded name.
 *
 * 📖 Returns the profile's TUI settings so the caller (main CLI) can apply them
 *    to the live state object (sortColumn, tierFilter, etc.).
 *
 * 📖 If the profile doesn't exist, returns null (caller should show an error).
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} name — Profile name to load
 * @returns {{ tierFilter: string|null, sortColumn: string, sortAsc: boolean, pingInterval: number }|null}
 *          The profile's TUI settings, or null if profile not found
 */
export function loadProfile(config, name) {
  const profile = config?.profiles?.[name]
  if (!profile) return null

  // 📖 Deep-copy the profile data into the live config (don't share references)
  config.apiKeys = JSON.parse(JSON.stringify(profile.apiKeys || {}))
  config.providers = JSON.parse(JSON.stringify(profile.providers || {}))
  config.favorites = [...(profile.favorites || [])]
  config.activeProfile = name

  return profile.settings ? { ..._emptyProfileSettings(), ...profile.settings } : _emptyProfileSettings()
}

/**
 * 📖 listProfiles: Get all saved profile names.
 *
 * @param {object} config
 * @returns {string[]} Array of profile names, sorted alphabetically
 */
export function listProfiles(config) {
  if (!config?.profiles || typeof config.profiles !== 'object') return []
  return Object.keys(config.profiles).sort()
}

/**
 * 📖 deleteProfile: Remove a named profile from the config.
 *
 * 📖 If the deleted profile is the active one, clears activeProfile.
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string} name — Profile name to delete
 * @returns {boolean} True if the profile existed and was deleted
 */
export function deleteProfile(config, name) {
  if (!config?.profiles?.[name]) return false
  delete config.profiles[name]
  if (config.activeProfile === name) config.activeProfile = null
  return true
}

/**
 * 📖 getActiveProfileName: Get the currently active profile name.
 *
 * @param {object} config
 * @returns {string|null} Profile name, or null if no profile is active
 */
export function getActiveProfileName(config) {
  return config?.activeProfile || null
}

/**
 * 📖 setActiveProfile: Set which profile is active (or null to clear).
 *
 * 📖 This just stores the name — it does NOT load the profile's data.
 *    Call loadProfile() first to actually apply the profile's values.
 *
 * @param {object} config — Live config object (will be mutated)
 * @param {string|null} name — Profile name, or null to clear
 */
export function setActiveProfile(config, name) {
  config.activeProfile = name || null
}

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    // 📖 Pinned favorites rendered at top of the table ("providerKey/modelId").
    favorites: [],
    // 📖 Telemetry consent is explicit. null = not decided yet.
    telemetry: {
      enabled: null,
      consentVersion: 0,
      anonymousId: null,
    },
    // 📖 Active profile name — null means no profile is loaded (using raw config).
    activeProfile: null,
    // 📖 Named profiles: each is a snapshot of apiKeys + providers + favorites + settings.
    profiles: {},
  }
}
