export const hasClaudeIdentifier = (text: string) => {
  const sanitizedText = text.trim().toLowerCase()

  // Helper function to remove punctuation from a word
  const stripPunctuation = (word: string) => {
    return word.replace(/[.,!?;:"'()[\]{}]/g, '')
  }

  // Split into words and strip punctuation
  const words = sanitizedText.split(' ').map(stripPunctuation)

  // if second word is claude and first word is anything
  if (words.length >= 2 && (words[1] === 'claude' || words[1] === 'cloud')) {
    return true
  }

  // if first word is claude
  if (words.length >= 1 && (words[0] === 'claude' || words[0] === 'cloud')) {
    return true
  }

  // if first word is anything, second word is dear, and third word is claude
  if (
    words.length >= 3 &&
    words[1] === 'dear' &&
    (words[2] === 'claude' || words[2] === 'cloud')
  ) {
    return true
  }

  // get only the first 15 characters of sanitized text
  const first15 = sanitizedText.substring(0, 15)
  if (
    first15.includes('claudothy') ||
    first15.includes('claudette') ||
    first15.includes('clud') ||
    first15.includes('cluade') ||
    first15.includes('claude-kun')
  ) {
    return true
  }

  // Also check if "claude" appears anywhere in the text with word boundaries
  // This catches cases like "@claude" or "claude:" that might not fit the patterns above
  if (/\bclaude\b/i.test(text)) {
    return true
  }

  return false
}
