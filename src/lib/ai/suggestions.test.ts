import { describe, expect, it } from 'vitest'

import { parseSuggestions } from './suggestions'
import { MAX_SUGGESTION_LEN } from './defaults'

describe('parseSuggestions', () => {
  it('parses the format the prompt asks for', () => {
    expect(
      parseSuggestions(
        '- Sure, I can help with that.\n- Let me check and get back to you.\n- Could you share your order number?',
      ),
    ).toEqual([
      'Sure, I can help with that.',
      'Let me check and get back to you.',
      'Could you share your order number?',
    ])
  })

  it('tolerates numbering, quotes and blank lines', () => {
    // What models actually return when they ignore "start each line
    // with -".
    expect(
      parseSuggestions('1. "Happy to help!"\n\n2) Give me one moment.\n\n3. Sure thing.'),
    ).toEqual(['Happy to help!', 'Give me one moment.', 'Sure thing.'])
  })

  it('drops a commentary preamble', () => {
    expect(
      parseSuggestions('Here are three replies you could send:\n- Yes.\n- No.'),
    ).toEqual(['Yes.', 'No.'])
  })

  it('keeps a real reply that happens to end in a colon', () => {
    // The preamble rule must not eat a bulleted option.
    expect(parseSuggestions('- Here is what I can offer:')).toEqual([
      'Here is what I can offer:',
    ])
  })

  it('dedupes case-insensitively', () => {
    expect(parseSuggestions('- Sure thing\n- sure thing\n- On it')).toEqual([
      'Sure thing',
      'On it',
    ])
  })

  it('drops an option longer than the cap', () => {
    const long = 'x'.repeat(MAX_SUGGESTION_LEN + 1)
    expect(parseSuggestions(`- ${long}\n- Short one`)).toEqual(['Short one'])
  })

  it('caps how many are returned', () => {
    expect(parseSuggestions('- a\n- b\n- c\n- d\n- e', 2)).toEqual(['a', 'b'])
  })

  it('falls back to the whole answer when the model wrote a paragraph', () => {
    // One usable suggestion beats showing the agent nothing.
    expect(parseSuggestions('Thanks for reaching out, I can help with that.')).toEqual(
      ['Thanks for reaching out, I can help with that.'],
    )
  })

  it('returns nothing for empty or unusable output', () => {
    expect(parseSuggestions('')).toEqual([])
    expect(parseSuggestions('   \n  \n')).toEqual([])
    // A single over-long paragraph is not worth surfacing.
    expect(parseSuggestions('y'.repeat(MAX_SUGGESTION_LEN + 5))).toEqual([])
  })
})
