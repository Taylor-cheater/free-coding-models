/**
 * request-transformer.js
 *
 * Utilities for transforming outgoing API request bodies before they are
 * forwarded to a model provider:
 *   - applyThinkingBudget  — control Anthropic-style "thinking" budget
 *   - compressContext      — reduce prompt size at increasing compression levels
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count the total characters contributed by a single message.
 * Handles both plain-string content and array-of-blocks content.
 *
 * @param {object} msg
 * @returns {number}
 */
function messageCharCount(msg) {
  if (typeof msg.content === 'string') return msg.content.length
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, block) => {
      if (block.type === 'text') return sum + (block.text?.length || 0)
      if (block.type === 'thinking') return sum + (block.thinking?.length || 0)
      return sum
    }, 0)
  }
  return 0
}

// ---------------------------------------------------------------------------
// applyThinkingBudget
// ---------------------------------------------------------------------------

/**
 * Attach (or omit) an Anthropic-style "thinking" budget to the request body.
 *
 * Modes:
 *   'passthrough' — return a shallow copy of body with no changes
 *   'custom'      — add thinking: { budget_tokens: config.budget_tokens }
 *   'auto'        — add thinking only when the total prompt is > 2 000 chars;
 *                   budget is proportional: min(totalChars * 2, 32 000)
 *
 * The original body is NEVER mutated.
 *
 * @param {object} body        - The request body (OpenAI-compatible shape)
 * @param {{ mode: string, budget_tokens?: number }} config
 * @returns {object}           - A new body object
 */
export function applyThinkingBudget(body, config) {
  const { mode } = config

  if (mode === 'passthrough') {
    return { ...body }
  }

  if (mode === 'custom') {
    return { ...body, thinking: { budget_tokens: config.budget_tokens } }
  }

  if (mode === 'auto') {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const totalChars = messages.reduce((sum, msg) => {
      if (typeof msg.content === 'string') return sum + msg.content.length
      if (Array.isArray(msg.content)) {
        return sum + msg.content.reduce((s, block) => {
          if (typeof block === 'string') return s + block.length
          return s + (block.text?.length || 0) + (block.thinking?.length || 0)
        }, 0)
      }
      return sum
    }, 0)

    if (totalChars > 2000) {
      const budget_tokens = Math.min(Math.floor(totalChars * 2), 32000)
      return { ...body, thinking: { budget_tokens } }
    }

    return { ...body }
  }

  // Unknown mode — return shallow copy unchanged
  return { ...body }
}

// ---------------------------------------------------------------------------
// compressContext
// ---------------------------------------------------------------------------

/**
 * Reduce the size of the messages array at increasing compression levels.
 *
 * Levels:
 *   0 — no change (shallow copy of array)
 *   1 — truncate tool-result messages whose content exceeds toolResultMaxChars
 *   2 — L1 + truncate thinking blocks in assistant messages
 *   3 — L2 + drop oldest non-system messages when total chars exceed maxTotalChars
 *
 * The original messages array and its objects are NEVER mutated.
 *
 * @param {object[]} messages
 * @param {{
 *   level?: number,
 *   toolResultMaxChars?: number,
 *   thinkingMaxChars?: number,
 *   maxTotalChars?: number
 * }} opts
 * @returns {object[]}
 */
export function compressContext(messages, opts = {}) {
  const {
    level = 0,
    toolResultMaxChars = 4000,
    thinkingMaxChars = 1000,
    maxTotalChars = 100000,
  } = opts

  if (level === 0) {
    return [...messages]
  }

  // L1: trim oversized tool results
  let result = messages.map(msg => {
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.length > toolResultMaxChars) {
        return {
          ...msg,
          content: msg.content.slice(0, toolResultMaxChars) + '\n[truncated]',
        }
      }
    }
    return msg
  })

  if (level === 1) {
    return result
  }

  // L2: trim thinking blocks in assistant messages
  result = result.map(msg => {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const newContent = msg.content.map(block => {
        if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking.length > thinkingMaxChars
        ) {
          return { ...block, thinking: block.thinking.slice(0, thinkingMaxChars) }
        }
        return block
      })
      // Only create a new message object when something actually changed
      const changed = newContent.some((b, i) => b !== msg.content[i])
      return changed ? { ...msg, content: newContent } : msg
    }
    return msg
  })

  if (level === 2) {
    return result
  }

  // L3: drop oldest non-system messages until total chars is within budget
  // Always preserve: every 'system' message, and the last message in the array.
  const totalChars = () => result.reduce((sum, msg) => sum + messageCharCount(msg), 0)

  while (totalChars() > maxTotalChars && result.length > 1) {
    // Find the first droppable message: not 'system', not the last one
    const dropIdx = result.findIndex(
      (msg, idx) => msg.role !== 'system' && idx !== result.length - 1
    )
    if (dropIdx === -1) break // nothing left to drop
    result = [...result.slice(0, dropIdx), ...result.slice(dropIdx + 1)]
  }

  return result
}
