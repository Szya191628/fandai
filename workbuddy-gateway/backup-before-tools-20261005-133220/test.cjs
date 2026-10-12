'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createGatewayServer, parseCliOutput, buildCliArgs } = require('./gateway.cjs');

const KEY = 'test-only-key';
const MODELS = [
  { id: 'hy4-preview', displayName: 'Hy4 preview', cliModel: 'hy4-preview' },
  { id: 'hy4-pro', displayName: 'Hy4 Pro', cliModel: 'hy4-pro' },
];
const cliOutput = (events = [
  { type: 'message', providerData: { usage: { inputTokens: 70, outputTokens: 30 } } },
  { type: 'result', subtype: 'success', result: 'Hello from WorkBuddy', usage: { input_tokens: 7, output_tokens: 3 } },
]) => JSON.stringify(events);

async function serve(t, options = {}) {
  const server = createGatewayServer({ apiKey: KEY, models: [], runner: async () => cliOutput(), ...options });
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
  assert.deepEqual((await models.json()).data.map(model => model.id), ['workbuddy-default']);
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

test('rejects unsupported models and text beyond limits', async t => {
  const base = await serve(t);
  const cases = [
    [{ ...validBody, model: 'other' }, /requested model is not supported/],
    [{ ...validBody, messages: Array.from({ length: 1001 }, () => ({ role: 'user', content: 'hi' })) }, /At most 1000 messages/],
    [{ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] }, /1 MiB/],
    [{ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(512 * 1024) }] }, /512 Ki characters/],
  ];
  for (const [input, expected] of cases) {
    const response = await chat(base, input);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, expected);
  }
});

test('gracefully converts image inputs to placeholder text', async t => {
  let prompt;
  const base = await serve(t, { runner: async value => { prompt = value; return cliOutput(); } });
  const response = await chat(base, {
    ...validBody,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this image: ' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
        ]
      }
    ]
  });
  assert.equal(response.status, 200);
  assert.match(prompt, /\[Image provided by user\]/);
});

test('supports tools and tool messages via prompt conversion', async t => {
  let prompt;
  const base = await serve(t, { runner: async value => { prompt = value; return cliOutput(); } });
  const response = await chat(base, {
    ...validBody,
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    messages: [
      { role: 'user', content: 'What is the weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather' } }] },
      { role: 'tool', name: 'get_weather', content: 'Sunny 25C' }
    ]
  });
  assert.equal(response.status, 200);
  assert.match(prompt, /Available tools:/);
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /\[Tool Result: get_weather\] Sunny 25C/);
});

test('accepts requests larger than 256 KiB within the new limits', async t => {
  let prompt;
  const base = await serve(t, { runner: async value => { prompt = value; return cliOutput(); } });
  const content = 'x'.repeat(300 * 1024);
  const response = await chat(base, { ...validBody, messages: [{ role: 'user', content }] });
  assert.equal(response.status, 200);
  assert.ok(prompt.includes(content));
});

test('rejects request bodies larger than 4 MiB', async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy-default', messages: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }] }),
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

test('routes allowlisted models to distinct CLI arguments and leaves default unpinned', () => {
  const prompt = 'prompt-secret';
  const defaultArgs = buildCliArgs('codebuddy', prompt);
  const firstArgs = buildCliArgs('codebuddy', prompt, MODELS[0].id, MODELS[0].cliModel);
  const secondArgs = buildCliArgs('codebuddy', prompt, MODELS[1].id, MODELS[1].cliModel);
  assert.deepEqual(defaultArgs.slice(0, 4), ['codebuddy', '-p', '--input-format', 'text']);
  assert.equal(defaultArgs.includes(prompt), false);
  assert.equal(defaultArgs.includes('--model'), false);
  assert.deepEqual(firstArgs.slice(-2), ['--model', 'hy4-preview']);
  assert.deepEqual(secondArgs.slice(-2), ['--model', 'hy4-pro']);
  assert.throws(() => buildCliArgs('codebuddy', 'prompt', 'attacker', '--help'));
});

test('forwards the exact UTF-8 prompt through stdin to a local Node CLI fixture', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workbuddy-gateway-'));
  const cliPath = join(dir, 'fixture.cjs');
  writeFileSync(cliPath, "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(JSON.stringify([{ type: 'result', subtype: 'success', result: input }])));");
  const server = createGatewayServer({ apiKey: KEY, models: [], nodePath: process.execPath, cliPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const messages = [{ role: 'user', content: '你好，stdin ✓' }];
  const response = await chat(base, { model: 'workbuddy-default', messages });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.choices[0].message.content, `Continue this conversation as the assistant. Reply to the latest user message. Messages are JSON:\n${JSON.stringify(messages)}`);
});

test('lists catalog models and preserves the requested model in JSON and SSE responses', async t => {
  const contexts = [];
  const base = await serve(t, {
    models: MODELS,
    runner: async (_prompt, context) => { contexts.push(context); return cliOutput(); },
  });
  const listed = await fetch(`${base}/v1/models`, { headers: headers() });
  const models = await listed.json();
  assert.deepEqual(models.data.map(model => model.id), ['workbuddy-default', 'hy4-preview', 'hy4-pro']);
  assert.equal(models.data[1].display_name, 'Hy4 preview');

  const jsonResponse = await chat(base, { ...validBody, model: 'hy4-preview' });
  const completion = await jsonResponse.json();
  assert.equal(completion.model, 'hy4-preview');
  assert.equal(Object.hasOwn(completion, 'workbuddy_actual_model'), false);
  assert.equal(contexts[0].model, 'hy4-preview');
  assert.equal(contexts[0].cliModel, 'hy4-preview');

  const streamResponse = await chat(base, { ...validBody, model: 'hy4-pro', stream: true });
  assert.equal(streamResponse.status, 200);
  const streamData = await streamResponse.text();
  assert.match(streamData, /"model":"hy4-pro"/);
  assert.equal(contexts[1].cliModel, 'hy4-pro');
});

test('adds reported actual model identity to non-streaming completions only when present', async t => {
  const output = JSON.stringify([
    { type: 'message', message: { role: 'assistant' }, providerData: { model: 'hy4-preview', requestModelId: 'hy4-preview' } },
    { type: 'result', subtype: 'success', result: 'answer' },
  ]);
  const base = await serve(t, { models: MODELS, runner: async () => output });
  const response = await chat(base, { ...validBody, model: 'hy4-preview' });
  assert.equal((await response.json()).workbuddy_actual_model, 'hy4-preview');
});

test('reports only actual model identities found in the last assistant providerData', () => {
  const parsed = parseCliOutput(JSON.stringify([
    { type: 'message', role: 'assistant', providerData: { model: 'old-model', requestModelId: 'old-request' } },
    { type: 'message', role: 'user', providerData: { model: 'user-model', requestModelId: 'user-request' } },
    { type: 'message', message: { role: 'assistant' }, providerData: { model: 'hy4-preview', requestModelId: 'hy4-preview' } },
    { type: 'result', subtype: 'success', result: 'answer' },
  ]));
  assert.equal(parsed.actualModel, 'hy4-preview');
  assert.equal(parsed.requestModelId, 'hy4-preview');

  const missing = parseCliOutput(cliOutput([{ type: 'result', subtype: 'success', result: 'answer' }]));
  assert.equal(missing.actualModel, null);
  assert.equal(missing.requestModelId, null);
  const stale = parseCliOutput(JSON.stringify([
    { type: 'message', role: 'assistant', providerData: { model: 'old-model', requestModelId: 'old-model' } },
    { type: 'message', role: 'assistant' },
    { type: 'result', subtype: 'success', result: 'answer' },
  ]));
  assert.equal(stale.actualModel, null);
  assert.equal(stale.requestModelId, null);
});

test('rejects malformed injected catalogs before accepting requests', () => {
  assert.throws(() => createGatewayServer({ apiKey: KEY, models: [{ id: '--help', displayName: 'bad', cliModel: '--help' }] }), /invalid model entry/);
  assert.throws(() => createGatewayServer({ apiKey: KEY, models: [{ id: 'public-id', displayName: 'bad', cliModel: 'cli-id' }] }), /invalid model entry/);
  assert.throws(() => createGatewayServer({ apiKey: KEY, models: [MODELS[0], MODELS[0]] }), /duplicate model IDs/);
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
