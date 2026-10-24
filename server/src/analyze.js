import { GEMINI_TIMEOUT_MS, METHOD_RISK, TAG_LIST } from './config.js';

// Bridge to C's analyze() in ./risk/index.js. If that file is missing, throws, or hangs,
// the server still works with a minimal built-in result.
const RISK_ORDER = { low: 0, medium: 1, high: 2 };
const maxRisk = (a, b) => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

async function loadAnalyze() {
  try {
    const mod = await import('./risk/index.js');
    return typeof mod.analyze === 'function' ? mod.analyze : null;
  } catch {
    return null;
  }
}
let analyzePromise;

function fallback({ paymentMethod, amount, firstRequest }) {
  return {
    tags: firstRequest ? ['FIRST_REQUEST'] : [],
    paymentRisk: METHOD_RISK[paymentMethod] || 'low',
    amount: amount ?? null,
    explanation: '',
    source: 'rules',
  };
}

// Whatever comes back is validated here: unknown tags dropped, extra fields ignored,
// the payment risk can never be lower than the selector value, and the explanation is display-only.
export function sanitize(raw, input) {
  const base = fallback(input);
  const r = raw && typeof raw === 'object' ? raw : {};
  const tags = new Set(Array.isArray(r.tags) ? r.tags.filter((t) => TAG_LIST.includes(t)) : []);
  if (input.firstRequest) tags.add('FIRST_REQUEST');
  const rawRisk = RISK_ORDER[r.paymentRisk] !== undefined ? r.paymentRisk : 'low';
  return {
    tags: [...tags],
    paymentRisk: maxRisk(rawRisk, base.paymentRisk),
    amount: Number.isFinite(r.amount) ? r.amount : base.amount,
    explanation: typeof r.explanation === 'string' ? r.explanation.slice(0, 140) : '',
    source: r.source === 'gemini' ? 'gemini' : 'rules',
  };
}

export async function analyzeSafe(input, { analyze, timeoutMs = GEMINI_TIMEOUT_MS } = {}) {
  try {
    analyzePromise ??= loadAnalyze();
    const fn = analyze || await analyzePromise;
    if (!fn) return fallback(input);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('analyze timeout')), timeoutMs); });
    try {
      return sanitize(await Promise.race([Promise.resolve(fn(input)), timeout]), input);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return fallback(input);
  }
}
