import { analyzeRules } from './rules.js';

// analyze(): called by server/src/analyze.js (which adds its own 3 s timeout).
// Rules-only for now. Gemini will be added in gemini.js and can only ADD tags to these. Never throws.
export async function analyze(input) {
  try {
    return analyzeRules(input);
  } catch {
    return { tags: [], paymentRisk: 'low', amount: null, explanation: '', source: 'rules' };
  }
}

export { extractAmount } from './rules.js';
