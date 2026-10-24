// Every socket event name in one place. If docs/PROTOCOL.md uses different names, change them HERE only.
export const EV = {
  AUTH_CHALLENGE: 'auth:challenge',
  AUTH_LOGIN: 'auth:login',
  USER_REGISTER: 'user:register',
  CIRCLE_LIST: 'circle:list',
  PAIR_START: 'pair:start',
  PAIR_COMPLETE: 'pair:complete',
  PAIR_DONE: 'pair:done',
  VERIFY_REQUEST: 'verify:request',
  VERIFY_PROMPT: 'verify:prompt',
  VERIFY_ANSWER: 'verify:answer',
  VERIFY_WORD: 'verify:word',
  VERIFY_CONFIRM_PROMPT: 'verify:confirm_prompt',
  VERIFY_CONFIRM: 'verify:confirm',
  VERIFY_VERDICT: 'verify:verdict',
  CIRCLE_ALERT: 'circle:alert',
};
