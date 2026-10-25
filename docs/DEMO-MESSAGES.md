# Demo messages: they look real, Vouch catches them

Send these in a Telegram **group** that has Vouch Bot and the people you are protecting (or forward them to the bot). Nothing needs forwarding in a group: the bot reads each message as it arrives, warns in the chat when it matters, and flashes the Vouch app on every linked phone. Results below are from the real AI (Gemini), not from keyword rules. The AI is a warning, never a verdict: only a person can clear a request.

| Looks like | Send this | What Vouch says |
| --- | --- | --- |
| A bank alert | `Chase: A $482.17 purchase at BEST BUY was declined. If this wasn't you, review it now: https://chase-secure.review/alerts` | STOP: fake bank alert (lookalike link) |
| Your child, new number | `Hi mom, I dropped my phone in the lake lol, this is my new number. Can you save it? Also could you help me pay my phone bill today, I'm locked out of my banking app` | STOP: someone pretending to be your child |
| Your landlord | `Hello, quick note from the property office: we've moved to a new payment portal. Please pay this month's rent of $1,850 here: rentpay-portal.co/lease/2291.` | STOP: rent redirected to a lookalike site |
| A parcel | `UPS: We couldn't deliver your package 1Z84A9 today because the address is incomplete. Confirm your address within 24h: ups-delivery-confirm.com/1Z84A9` | STOP: fake delivery notice |
| A recruiter | `Hi Ada, loved your profile! Remote data entry at $38/hr. To start we send you a check for equipment, you deposit it and buy the laptop from our vendor.` | STOP: fake-cheque job scam |
| A friendly stranger | `Good morning my dear, I made $4,200 last week on the trading app my uncle showed me. It only takes $500 to begin and you can withdraw anytime.` | STOP: investment scam |
| A coworker | `Are you at your desk? I need a quick favor, I'm stuck in a meeting. Don't call, just reply here.` | CHECK: impersonation set-up (no ask yet) |
| An honest mistake | `Hey sorry I sent you $600 on Zelle by accident, can you send it back to this number?` | STOP: fake accidental transfer |
| An AI picture or video | A generated face or a synthetic clip, with or without a caption | CHECK: possibly AI-made (a hint, not proof). Video up to about 14 MB |

Genuine messages stay quiet (verified): a friend splitting a dinner bill, a pharmacy pickup text, a bank code that says "never share it", "pick up milk on the way home".

The AI is honest about its limits: telling a real photo from a generated one is unreliable, so that warning says "possibly" and never blocks anything.