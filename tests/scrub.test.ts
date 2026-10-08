import { describe, expect, it } from 'vitest'
import { scrubSecrets } from '../src/exec.js'

describe('scrubSecrets', () => {
  it('redacts known token shapes wherever they appear', () => {
    const text = [
      'GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      'boat boat_testabcdefghijklmnopqrstu',
      'linear lin_api_abcdefghijklmnopqrstuvwxyz',
      'aws AKIAABCDEFGHIJKLMNOP',
      'slack xoxb-1234567890-abcdefghij',
      'tailscale tskey-auth-abcdefghijk-lmnop',
    ].join('\n')
    const out = scrubSecrets(text)
    expect(out).not.toMatch(/ghp_|github_pat_|sk-|boat_test|lin_api_|AKIA|xoxb-|tskey-/)
    expect(out.split('<redacted>')).toHaveLength(10)
  })
  it('leaves ordinary text alone', () => {
    const text = 'task-123 ok, sk-1 and ghp_short stay, ask-me-anything too'
    expect(scrubSecrets(text)).toBe(text)
  })
})
