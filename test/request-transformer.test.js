import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyThinkingBudget, compressContext } from '../lib/request-transformer.js'

describe('applyThinkingBudget', () => {
  it('passthrough mode: leaves body unchanged', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8000 }
    const result = applyThinkingBudget(body, { mode: 'passthrough' })
    assert.deepStrictEqual(result, body)
  })

  it('custom mode: sets thinking budget', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }] }
    const result = applyThinkingBudget(body, { mode: 'custom', budget_tokens: 10000 })
    assert.strictEqual(result.thinking?.budget_tokens, 10000)
  })

  it('auto mode: adds thinking for long prompts', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }
    const result = applyThinkingBudget(body, { mode: 'auto' })
    assert.ok(result.thinking?.budget_tokens > 0)
  })

  it('auto mode: no thinking for short prompts', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }] }
    const result = applyThinkingBudget(body, { mode: 'auto' })
    assert.strictEqual(result.thinking, undefined)
  })

  it('does not mutate original body', () => {
    const body = { model: 'test', messages: [{ role: 'user', content: 'hi' }] }
    const original = JSON.stringify(body)
    applyThinkingBudget(body, { mode: 'custom', budget_tokens: 5000 })
    assert.strictEqual(JSON.stringify(body), original)
  })
})

describe('compressContext', () => {
  it('L0: no compression', () => {
    const msgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]
    assert.strictEqual(compressContext(msgs, { level: 0 }).length, 2)
  })

  it('L1: trims large tool results', () => {
    const msgs = [
      { role: 'tool', content: 'x'.repeat(10000), tool_call_id: 'tc1' },
    ]
    const result = compressContext(msgs, { level: 1, toolResultMaxChars: 2000 })
    assert.ok(result[0].content.length < 3000)
    assert.ok(result[0].content.includes('[truncated]'))
  })

  it('L1: preserves small tool results', () => {
    const msgs = [{ role: 'tool', content: 'short', tool_call_id: 'tc1' }]
    assert.strictEqual(compressContext(msgs, { level: 1 })[0].content, 'short')
  })

  it('L2: compresses thinking blocks', () => {
    const msgs = [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'x'.repeat(5000) },
        { type: 'text', text: 'Final answer' },
      ],
    }]
    const result = compressContext(msgs, { level: 2, thinkingMaxChars: 500 })
    const thinking = result[0].content.find(b => b.type === 'thinking')
    assert.ok(!thinking || thinking.thinking.length < 1000)
  })

  it('L3: removes oldest non-system messages when over limit', () => {
    const msgs = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'x'.repeat(60000) },
      { role: 'assistant', content: 'y'.repeat(60000) },
      { role: 'user', content: 'latest question' },
    ]
    const result = compressContext(msgs, { level: 3, maxTotalChars: 80000 })
    assert.ok(result.length < 4, 'Should have dropped old messages')
    assert.strictEqual(result[0].role, 'system', 'System message preserved')
    assert.strictEqual(result[result.length - 1].content, 'latest question', 'Latest message preserved')
  })

  it('does not mutate original messages', () => {
    const msgs = [{ role: 'tool', content: 'x'.repeat(5000), tool_call_id: 'tc1' }]
    const original = msgs[0].content.length
    compressContext(msgs, { level: 1, toolResultMaxChars: 100 })
    assert.strictEqual(msgs[0].content.length, original)
  })
})
