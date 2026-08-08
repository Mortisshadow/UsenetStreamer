'use strict';

const MAX_PATTERN_LENGTH = 2000;

function quantifierLengthAt(pattern, index) {
  if (pattern[index] === '+' || pattern[index] === '*' || pattern[index] === '?') return 1;
  const match = pattern.slice(index).match(/^\{\d+(?:,\d*)?\}/);
  return match ? match[0].length : 0;
}

function repeatsGroupAt(pattern, index) {
  if (pattern[index] === '+' || pattern[index] === '*') return true;
  if (pattern[index] === '?') return false;
  const match = pattern.slice(index).match(/^\{(\d+)(?:,(\d*)?)?\}/);
  if (!match) return false;
  if (match[2] === undefined) return Number(match[1]) > 1;
  return match[2] === '' || Number(match[2]) > 1;
}

function hasNestedQuantifier(pattern) {
  const stack = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') { i += 1; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') {
      stack.push({ containsQuantifier: false });
      // Skip group syntax such as (?:...), (?=...), (?!...), and (?<name>...).
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!') {
          const end = pattern.indexOf('>', i + 3);
          if (end !== -1) i = end;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (char === ')') {
      const group = stack.pop();
      const outerLength = quantifierLengthAt(pattern, i + 1);
      if (group?.containsQuantifier && repeatsGroupAt(pattern, i + 1)) return true;
      if ((group?.containsQuantifier || outerLength) && stack.length) stack[stack.length - 1].containsQuantifier = true;
      continue;
    }
    const quantifierLength = quantifierLengthAt(pattern, i);
    if (quantifierLength && stack.length) {
      stack[stack.length - 1].containsQuantifier = true;
      i += quantifierLength - 1;
    }
  }
  return false;
}

// This is deliberately conservative. JavaScript has no built-in regexp timeout,
// so reject ambiguous repetition before compiling administrator-supplied rules.
function validateSafeRegex(pattern, flags = '') {
  if (typeof pattern !== 'string') return { kind: 'type', message: 'Pattern must be a string' };
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { kind: 'length', message: `Pattern exceeds ${MAX_PATTERN_LENGTH} characters` };
  }
  if (/[^dgimsuvy]/.test(flags) || new Set(flags).size !== flags.length) {
    return { kind: 'flags', message: 'Pattern contains invalid or duplicate flags' };
  }

  // Nested quantified groups, e.g. (a+)+, (.*)* and (a{1,}){2,}.
  if (hasNestedQuantifier(pattern)) {
    return { kind: 'nested-quantifier', message: 'Pattern contains nested repetition and may cause catastrophic backtracking' };
  }
  // Overlapping alternatives under repetition, e.g. (a|aa)+. Exact language
  // analysis is undecidable here; repeated alternatives sharing a prefix are a
  // useful conservative signal without rejecting ordinary release regexes.
  const repeatedAlternation = /\(([^()]*)\)(?:[+*]|\{\d+,?\d*\})/g;
  let match;
  while ((match = repeatedAlternation.exec(pattern))) {
    const alternatives = match[1].split('|').map((part) => part.replace(/^\?:/, ''));
    for (let i = 0; i < alternatives.length; i += 1) {
      for (let j = i + 1; j < alternatives.length; j += 1) {
        if (alternatives[i] && alternatives[j]
          && (alternatives[i].startsWith(alternatives[j]) || alternatives[j].startsWith(alternatives[i]))) {
          return { kind: 'ambiguous-alternation', message: 'Repeated alternatives share a prefix and may backtrack excessively' };
        }
      }
    }
  }
  try { new RegExp(pattern, flags); }
  catch (error) { return { kind: 'compile', message: `Invalid regex: ${error.message}` }; }
  return null;
}

module.exports = { MAX_PATTERN_LENGTH, validateSafeRegex };
