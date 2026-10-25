// Every socket event name in one place (docs/PROTOCOL.md v2).
export const EV = {
  AUTH_CHALLENGE: 'auth:challenge',
  AUTH_LOGIN: 'auth:login',
  USER_REGISTER: 'user:register',
  CIRCLE_LIST: 'circle:list',
  PAIR_OFFER: 'pair:offer',
  PAIR_ACCEPT: 'pair:accept',
  PAIR_COMPLETED: 'pair:completed',
  VERIFY_REQUEST: 'verify:request',
  VERIFY_PROMPT: 'verify:prompt',
  VERIFY_ANSWER: 'verify:answer',
  VERIFY_WORDCHECK: 'verify:wordcheck',
  VERIFY_CONFIRM_PROMPT: 'verify:confirm_prompt',
  VERIFY_CONFIRM: 'verify:confirm',
  VERIFY_UPDATE: 'verify:update',
  CIRCLE_ALERT: 'circle:alert',
  DEMO_RESET: 'demo:reset',
};
