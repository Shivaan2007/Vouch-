import { TAG_LIST } from '../config.js';
import { analyzeRules } from './rules.js';
import { geminiAnalyze } from './gemini.js';

const EMPTY = { tags: [], paymentRisk: 'low', amount: null, explanation: '', source: 'rules' };

// analyze(): called by server/src/analyze.js, which adds its own 3 s race. Never throws.
// Rules always run. Gemini can only ADD tags (final tags = rules UNION Gemini) and supply the explanation sentence.
// It never changes the payment risk, never removes a tag and never produces a verdict. Without a key, or on any
// problem, the rules-only result comes back with source: "rules". `opts` is for tests (apiKey, fetchImpl, timeoutMs).
export async function analyze(input, opts = {}) {
  let rules;
  try {
    rules = analyzeRules(input);
  } catch {
    return { ...EMPTY };
  }
  try {
    const g = await geminiAnalyze(
      { text: typeof input?.text === 'string' ? input.text : '', imageBase64: input?.imageBase64 }, opts,
    );
    if (!g) return rules;
    const tags = TAG_LIST.filter((t) => rules.tags.includes(t) || g.tags.includes(t));
    return { ...rules, tags, explanation: g.explanation || rules.explanation, source: 'gemini' };
  } catch {
    return rules;
  }
}

export { extractAmount } from './rules.js';
