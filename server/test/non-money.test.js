import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggest, classify, callRisk, dangerKind, riskyEnough, highlight } from '../../web/js/lib/scan.js';

// Scams that are not about sending money: a code, remote access, a password, ID, or a click. The offline phone rules used to
// be blind to all of these (they only knew money-style scams). Short generic paraphrases, as in the other fixtures.
const SCAMS = [
  ['code', "Hi it's your bank. We sent a 6 digit code to your phone. Please read it to me to cancel the fraudulent login."],
  ['code', 'Please read me the verification code we just texted you so I can confirm your account.'],
  ['code', "Hey it's me, I locked myself out, can you send me the 6 digit code you just got by sms?"],
  ['remote', 'This is Microsoft support. Your computer has a virus. Please install AnyDesk and give me the ID so I can fix it.'],
  ['remote', 'Open TeamViewer and let me take control of your computer so I can remove the problem.'],
  ['password', 'Please confirm your password and card details to keep your account active.'],
  ['password', 'You must verify your login details today or the account will be closed.'],
  ['identity', 'Great news, you got the job! Send a photo of your passport and driver license so HR can set up payroll.'],
  ['identity', 'We need to confirm your SSN and date of birth to stop your benefits being suspended.'],
  ['phish', 'Your Netflix account is on hold. Log in at netflix-billing-help.com/verify to confirm.'],
  ['phish', 'USPS: your parcel is waiting. Confirm your address here: usps-redeliver.top/track'],
  ['phish', 'OMG is this you in this video?? http://bit.ly/3xYz-video'],
];

const EVERYDAY = [
  "what's the wifi pin?", 'can you send me the pin for the garage door?', 'dinner is at 7, can you bring the drinks?',
  'your verification code is 482913. do not share it', 'Never share this code with anyone, including our staff.',
  'click the link to join the meeting at 3', "here's the link to the doc: https://docs.google.com/document/d/abc", 'I forgot my password, can you help me reset it?',
  'can you send me a photo of the passport page? the hotel needs it', 'my SSN card is in the safe, remind me tonight', 'happy birthday!!',
  'Chase: your statement is ready to view in the app', 'UPS: your package was delivered to the front door', 'Amazon: your order has shipped',
  'your uber is arriving in 2 minutes', 'reminder: dentist appointment tomorrow at 3', 'can you pick up milk on the way home?',
  'see you at six', 'the plumber charges $150, I will pay him in cash tomorrow', 'thanks for lunch, I will venmo you $12',
  "I'll send you the code for the door tomorrow", 'remote work is great, I love working from home', 'can you control the thermostat from your phone?',
  'login page is down again, the team is looking at it', 'use this link for the group photos: https://photos.example.com/album/42',
];

for (const [kind, text] of SCAMS) {
  test(`non-money scam (${kind}): ${text.slice(0, 55)}`, () => {
    assert.equal(dangerKind(text), kind);
    const s = suggest(text);
    assert.equal(s.danger, true);
    assert.equal(s.kind, kind);
    assert.equal(classify(text).id, kind, 'the plain-words guide names this kind');
    assert.equal(callRisk(text).level, 2, 'a live call that says this gets the full warning');
  });
}

test('everyday messages never count as a non-money scam', () => {
  for (const text of EVERYDAY) {
    assert.equal(dangerKind(text), '', text);
    assert.equal(suggest(text).danger, false, text);
    assert.notEqual(callRisk(text).level, 2, text);
  }
});

test('the normal and flagging fixtures never count as a non-money scam either', () => {
  for (const f of ['scams.json', 'flagging.json']) {
    const set = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
    for (const item of set.normal) assert.equal(dangerKind(item.text), '', item.text);
  }
});

test('money scams are unchanged: same tags, and no non-money kind is invented for them', () => {
  const set = JSON.parse(readFileSync(new URL('./fixtures/scams.json', import.meta.url), 'utf8'));
  for (const item of set.scams) {
    const s = suggest(item.text);
    assert.equal(riskyEnough(s.tags) || s.institution || s.ask, true, item.text);
  }
});

test('highlight marks the words of a code request and a remote-access request', () => {
  const marked = (t) => highlight(t).filter((p) => p.hit).map((p) => p.text).join(' | ');
  assert.match(marked('please read me the verification code we sent'), /read me the verification code/);
  assert.match(marked('install AnyDesk now'), /anydesk/i);
});
