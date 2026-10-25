// Links in a message, pulled out and taken apart into plain FACTS. Code does the parsing (a model is bad at it and it must be
// exact); it does not judge the link and it never visits it. The AI reads these facts together with the message and decides how
// risky each link looks. `linkFloor` is only a small offline fallback for the most obvious tricks when there is no AI.

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+|(?:[a-z0-9-]+\.)+(?:com|net|org|co|io|app|info|biz|top|xyz|click|live|icu|cyou|cfd|zip|mov|shop|site|online|link|me|us|ru|cn|tk|ml|ga|cf|gq|ly|gl|to|cc|ws|support|help|secure|bank)(?:\/[^\s<>"')\]]*)?)/gi;
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'rebrand.ly', 'lnkd.in', 'wa.me', 'soo.gd', 's.id']);
const RISKY_TLDS = new Set(['zip', 'mov', 'top', 'xyz', 'click', 'live', 'icu', 'cyou', 'cfd', 'tk', 'ml', 'ga', 'cf', 'gq', 'ru', 'cn', 'ws', 'support', 'help', 'link']);
const LOGIN_WORDS = /(log-?in|sign-?in|verify|secure|account|update|confirm|password|billing|wallet|claim|refund|unlock|suspend|redeliver|tracking|invoice|payment|pay)/i;

/**
 * @param {string} text
 * @returns {Array<{url: string, host: string, tld: string, shortener: boolean, punycode: boolean, ip: boolean, userinfo: boolean,
 *   subdomains: number, hyphens: number, loginWords: boolean, riskyTld: boolean, path: string}>}
 */
export function extractLinks(text) {
  const found = [];
  const seen = new Set();
  for (const m of String(text ?? '').slice(0, 5000).matchAll(URL_RE)) {
    let raw = m[1].replace(/[.,;:!?]+$/, '');
    if (!raw || /^\d+(\.\d+)?$/.test(raw)) continue;
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^www\./i, 'www.')}`;
    let u;
    try { u = new URL(withScheme); } catch { continue; }
    const host = u.hostname.toLowerCase();
    if (!host.includes('.') || seen.has(host + u.pathname)) continue;
    seen.add(host + u.pathname);
    const parts = host.split('.');
    const tld = parts[parts.length - 1];
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/.test(host);
    found.push({
      url: raw.slice(0, 120), host, tld, shortener: SHORTENERS.has(host), punycode: host.split('.').some((p) => p.startsWith('xn--')), ip,
      userinfo: /@/.test(withScheme.split('/')[2] || ''), subdomains: Math.max(0, parts.length - 2), hyphens: (host.match(/-/g) || []).length,
      loginWords: LOGIN_WORDS.test(host + u.pathname), riskyTld: RISKY_TLDS.has(tld), path: u.pathname.slice(0, 60),
    });
    if (found.length >= 5) break;
  }
  return found;
}

/** The facts as one line each, for the AI to read. */
export function describeLinks(links) {
  return links.map((l, i) => `${i + 1}. ${l.url}  (host ${l.host}; tld .${l.tld}${l.shortener ? '; URL shortener' : ''}${l.punycode ? '; punycode/lookalike characters' : ''}${l.ip ? '; raw IP address' : ''}${l.userinfo ? '; has user@ in the address' : ''}${l.subdomains >= 3 ? `; ${l.subdomains} subdomains` : ''}${l.hyphens >= 2 ? `; ${l.hyphens} hyphens` : ''}${l.loginWords ? '; login/payment/verify words' : ''}${l.riskyTld ? '; tld often abused' : ''})`).join('\n');
}

/**
 * A small offline floor when there is no AI: only the unmistakable tricks. 'none' | 'medium' | 'high'.
 * @param {ReturnType<typeof extractLinks>} links
 */
export function linkFloor(links) {
  let r = 'none';
  for (const l of links) {
    if (l.ip || l.userinfo || l.punycode) return 'high';
    if (l.shortener || l.riskyTld || (l.loginWords && (l.hyphens >= 1 || l.subdomains >= 3))) r = 'medium';
  }
  return r;
}
