'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayServer, parseCliOutput } = require('./gateway.cjs');

const KEY = 'test-only-key';
const cliOutput = (events = [
  { type: 'message', providerData: { usage: { inputTokens: 70, outputTokens: 30 } } },
  { type: 'result', subtype: 'success', result: 'Hello from WorkBuddy', usage: { input_tokens: 7, output_tokens: 3 } },
]) => JSON.stringify(events);

async function serve(t, options = {}) {
  const server = createGatewayServer({ apiKey: KEY, runner: async () => cliOutput(), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function headers(token = KEY) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function chat(base, body, token = KEY) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { ...headers(token), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const validBody = { model: 'workbuddy-default', messages: [{ role: 'user', content: 'Hi' }] };

test('health is public; model listing and completions require bearer auth', async t => {
  const base = await serve(t);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  const models = await fetch(`${base}/v1/models`, { headers: headers() });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, 'workbuddy-default');
  assert.equal((await chat(base, validBody, '')).status, 401);
});

test('converts text messages and prefers result.usage over providerData.usage', async t => {
  let prompt;
  const base = await serve(t, { runner: async value => { prompt = value; return cliOutput(); } });
  const response = await chat(base, {
    model: 'workbuddy-default',
    messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Hi' }],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello from WorkBuddy');
  assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.match(prompt, /"role":"system"/);
  assert.match(prompt, /"content":"Hi"/);
});

test('rejects unsupported tools, images, models, and text beyond limits', async t => {
  const base = await serve(t);
  const cases = [
    [{ ...validBody, tools: [] }, /Tool calling is not supported/],
    [{ ...validBody, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }] }, /Image inputs are not supported/],
    [{ ...validBody, model: 'other' }, /Only model/],
    [{ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(65 * 1024) }] }, /64 KiB/],
    [{ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(12_100) }] }, /12,000 characters/],
  ];
  for (const [input, expected] of cases) {
    const response = await chat(base, input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, expected);
  }
});

test('rejects oversized request bodies', async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy-default', messages: [{ role: 'user', content: 'x'.repeat(257 * 1024) }] }),
  });
  assert.equal(response.status, 413);
});

test('sanitizes CLI failures and parses only a successful result event', async t => {
  const base = await serve(t, { runner: async () => { throw new Error('private prompt and token'); } });
  const response = await chat(base, validBody);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private prompt|token/);
  assert.throws(() => parseCliOutput(JSON.stringify([{ type: 'result', subtype: 'error', result: 'secret' }])), /WorkBuddy CLI request failed/);
  assert.throws(() => parseCliOutput(JSON.stringify([
    { type: 'result', subtype: 'success', result: 'stale answer' },
    { type: 'result', subtype: 'error', result: 'secret' },
  ])), /WorkBuddy CLI request failed/);
});

test('falls back to the last message providerData usage when result usage is absent', () => {
  const parsed = parseCliOutput(JSON.stringify([
    { type: 'message', providerData: { usage: { inputTokens: 9, outputTokens: 4 } } },
    { type: 'result', subtype: 'success', result: 'answer' },
  ]));
  assert.deepEqual(parsed.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
});

test('stream mode emits OpenAI SSE only after the runner completes', async t => {
  const base = await serve(t);
  const response = await chat(base, { ...validBody, stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const data = await response.text();
  assert.match(data, /"object":"chat\.completion\.chunk"/);
  assert.match(data, /"content":"Hello from WorkBuddy"/);
  assert.match(data, /"finish_reason":"stop"/);
  assert.match(data, /data: \[DONE\]/);
});

test('returns 429 while a model request is active', async t => {
  let markStarted;
  let finish;
  const started = new Promise(resolve => { markStarted = resolve; });
  const base = await serve(t, {
    runner: () => new Promise(resolve => { finish = resolve; markStarted(); }),
  });
  const first = chat(base, validBody);
  await started;
  const second = await chat(base, validBody);
  assert.equal(second.status, 429);
  finish(cliOutput());
  assert.equal((await first).status, 200);
});
