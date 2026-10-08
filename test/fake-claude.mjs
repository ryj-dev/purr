#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests: reads the prompt on stdin, answers in stream-json like `claude -p
// --output-format stream-json --verbose`, and logs its argv to $FAKE_CLAUDE_LOG.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
let prompt = '';
for await (const c of process.stdin) prompt += c;
const sid = randomUUID();
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, sid, resume, head: prompt.slice(0, 80) }) + '\n');

let answer = 'OK';
if (/context-gathering step/.test(prompt)) answer = 'CONTEXT NOTES:\n- app.js: adds a config with an API key';
else if (/Your lens: security/.test(prompt)) {
  answer = 'Here is what I found:\n' + JSON.stringify([{ file: 'app.js', line: 2, symbol: null, category: 'secrets', severity: 'must_fix',
    title: 'Hard-coded AWS key in app config', scenario: 'Anyone with repo access can use the key.', evidence: 'app.js:2', fix: 'Load it from the environment.', confidence: 0.9 }]);
} else if (/Your lens: deleted guarantees/.test(prompt)) {
  answer = JSON.stringify([{ file: 'app.js', line: 5, category: 'logic', severity: 'consider', title: 'Divides by zero when count is 0',
    scenario: 'A user with no items sees NaN.', evidence: 'app.js:5', fix: 'Guard count === 0.', confidence: 0.7 },
    { file: 'app.js', line: 6, category: 'logic', severity: 'must_fix', title: 'Speculative crash', scenario: 'Might crash.', confidence: 0.3 }]);
} else if (/Your lens: concurrency/.test(prompt)) {
  answer = JSON.stringify([{ file: 'app.js', line: 4, category: 'concurrency', severity: 'must_fix', title: 'Race on shared counter',
    scenario: 'Two requests interleave.', evidence: 'app.js:4', confidence: 0.6 }]);
} else if (/Your lens:/.test(prompt)) answer = '[]';
else if (/severity check/.test(prompt)) {
  const ids = [...prompt.matchAll(/"id": "(f-[0-9a-f]+)"/g)].map((m) => m[1]);
  const titles = [...prompt.matchAll(/"title": "([^"]+)"/g)].map((m) => m[1]);
  answer = JSON.stringify(ids.map((id, i) => ({ id, severity: /Speculative/.test(titles[i] ?? '') ? 'drop' : /Divides/.test(titles[i] ?? '') ? 'consider' : 'must_fix',
    scenario: 'checked', title: titles[i], confidence: 0.8 })));
} else if (/skeptical verifier/.test(prompt)) {
  answer = /AWS key/.test(prompt) ? '{"real": true, "confidence": 0.9, "severity": "must_fix", "note": "app.js:2 holds the key"}'
    : '{"real": false, "confidence": 0.8, "severity": "minor", "note": "guarded"}';
}

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: answer }] } });
out({ type: 'rate_limit_event', session_id: sid, rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1791361200 }, seven_day: { utilization: 0.2, resetsAt: 1791813600 } } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, num_turns: 1, result: answer,
  usage: { input_tokens: 10, cache_creation_input_tokens: resume ? 300 : 20000, cache_read_input_tokens: resume ? 26000 : 6000, output_tokens: 50 } });
