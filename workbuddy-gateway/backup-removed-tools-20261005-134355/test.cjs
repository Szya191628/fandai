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
const structuredCliOutput = (structured_output, result = '') => cliOutput([
  { type: 'result', subtype: 'success', result, structured_output },
]);

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

test('rejects image and unknown content parts', async t => {
  const base = await serve(t);
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
  assert.equal(response.status, 400);
  const unknown = await chat(base, { ...validBody, messages: [{ role: 'user', content: [{ type: 'audio', audio: 'x' }] }] });
  assert.equal(unknown.status, 400);
});

test('preserves assistant tool calls and matching tool results in the prompt', async t => {
  let prompt;
  const history = [
    { role: 'user', content: 'What is the weather?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: 'Sunny 25C' },
  ];
  const base = await serve(t, { runner: async value => { prompt = value; return structuredCliOutput({ content: 'It is sunny.', tool_calls: [] }); } });
  const response = await chat(base, {
    ...validBody,
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    messages: history,
  });
  assert.equal(response.status, 200);
  assert.match(prompt, /Available function tools/);
  assert.match(prompt, /get_weather/);
  const messagesStart = prompt.lastIndexOf('Messages are JSON:\n') + 'Messages are JSON:\n'.length;
  assert.deepEqual(JSON.parse(prompt.slice(messagesStart)), history);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'It is sunny.');
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('accepts empty tool lists with none or auto as plain text requests', async t => {
  const contexts = [];
  const base = await serve(t, {
    runner: async (_prompt, context) => { contexts.push(context); return cliOutput(); },
  });
  for (const tool_choice of ['none', 'auto']) {
    const response = await chat(base, { ...validBody, tools: [], tool_choice });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'Hello from WorkBuddy');
  }
  assert.deepEqual(contexts.map(context => context.toolMode), [false, false]);
});

test('validates function definitions, choices, legacy fields, and tool history', async t => {
  const base = await serve(t);
  const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } };
  const cases = [
    { ...validBody, function_call: 'auto' },
    { ...validBody, functions: [] },
    { ...validBody, tool_choice: 'required' },
    { ...validBody, tool_choice: { type: 'function', function: { name: 'lookup' } } },
    { ...validBody, tools: [{ ...tool, function: { ...tool.function, strict: true } }] },
    { ...validBody, tools: [tool, tool] },
    { ...validBody, tools: [tool], parallel_tool_calls: 'false' },
    { ...validBody, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'orphan' }] },
    { ...validBody, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_pending', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }] },
    { ...validBody, messages: [{ role: 'user', content: 'Hi', tool_calls: [] }] },
    { ...validBody, messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_bad', type: 'function', function: { name: 'lookup', arguments: '[]' } }] }] },
    { ...validBody, messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'one' },
      { role: 'tool', tool_call_id: 'call_1', content: 'duplicate' },
    ] },
  ];
  for (const input of cases) {
    const response = await chat(base, input);
    assert.equal(response.status, 400, JSON.stringify(input));
  }
});

test('returns declared tool calls with server-generated IDs and required choice enforcement', async t => {
  const base = await serve(t, {
    runner: async () => structuredCliOutput({ content: '', tool_calls: [{ name: 'lookup', arguments: '{"key":"x"}' }] }),
  });
  const response = await chat(base, {
    ...validBody,
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    tool_choice: 'required',
    parallel_tool_calls: false,
  });
  assert.equal(response.status, 200);
  const completion = await response.json();
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
  assert.equal(completion.choices[0].message.content, null);
  assert.match(completion.choices[0].message.tool_calls[0].id, /^call_[0-9a-f]{32}$/);
  assert.deepEqual(completion.choices[0].message.tool_calls[0].function, { name: 'lookup', arguments: '{"key":"x"}' });
});

test('rejects malformed and disallowed structured tool output with a sanitized 502', async t => {
  const definition = { type: 'function', function: { name: 'lookup' } };
  const cases = [
    { choice: 'auto', parallel: true, calls: [{ name: 'unknown', arguments: '{}' }] },
    { choice: 'auto', parallel: true, calls: [{ name: 'lookup', arguments: '[]' }] },
    { choice: 'none', parallel: true, calls: [{ name: 'lookup', arguments: '{}' }] },
    { choice: 'required', parallel: true, calls: [] },
    { choice: { type: 'function', function: { name: 'lookup' } }, parallel: true, calls: [{ name: 'other', arguments: '{}' }] },
    { choice: 'auto', parallel: false, calls: [{ name: 'lookup', arguments: '{}' }, { name: 'lookup', arguments: '{}' }] },
    { choice: 'auto', parallel: true, calls: Array.from({ length: 9 }, () => ({ name: 'lookup', arguments: '{}' })) },
  ];
  for (const item of cases) {
    const base = await serve(t, {
      runner: async () => structuredCliOutput({ content: 'private output', tool_calls: item.calls }),
    });
    const response = await chat(base, {
      ...validBody,
      tools: [definition],
      tool_choice: item.choice,
      parallel_tool_calls: item.parallel,
    });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.match(text, /invalid_tool_output/);
    assert.doesNotMatch(text, /private output|unknown|other/);
  }

  const missing = await serve(t, { runner: async () => cliOutput() });
  const response = await chat(missing, { ...validBody, tools: [definition] });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /invalid_tool_output/);
});

test('streams indexed tool-call deltas and ends with tool_calls', async t => {
  const base = await serve(t, {
    runner: async () => structuredCliOutput({ content: 'Searching', tool_calls: [
      { name: 'lookup', arguments: '{"key":"a"}' },
      { name: 'lookup', arguments: '{"key":"b"}' },
    ] }),
  });
  const response = await chat(base, {
    ...validBody,
    stream: true,
    tools: [{ type: 'function', function: { name: 'lookup' } }],
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
  const toolChunk = events.find(event => event.choices[0].delta.tool_calls);
  assert.deepEqual(toolChunk.choices[0].delta.tool_calls.map(call => call.index), [0, 1]);
  assert.ok(toolChunk.choices[0].delta.tool_calls.every(call => call.type === 'function' && call.id.startsWith('call_')));
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
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

test('enables only StructuredOutput for tool-mode CLI calls and keeps the fixed output schema small', () => {
  const args = buildCliArgs('codebuddy', 'prompt', 'workbuddy-default', null, { toolMode: true });
  assert.ok(args.includes('--tools=StructuredOutput'));
  assert.equal(args.includes('--tools='), false);
  const schemaArg = args[args.indexOf('--json-schema') + 1];
  const schema = JSON.parse(schemaArg);
  assert.deepEqual(schema.required, ['content', 'tool_calls']);
  assert.deepEqual(schema.properties.tool_calls.items.required, ['name', 'arguments']);
  assert.equal(schema.properties.tool_calls.maxItems, 8);
});

test('forwards the exact UTF-8 prompt through stdin to a local Node CLI fixture', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'workbuddy-gateway-'));
  const cliPath = join(dir, 'fixture.cjs');
  writeFileSync(cliPath, "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; }); process.stdin.on('end', () => { const toolMode = process.argv.includes('--tools=StructuredOutput'); const schemaIndex = process.argv.indexOf('--json-schema'); if (toolMode && (schemaIndex < 0 || !JSON.parse(process.argv[schemaIndex + 1]).properties.tool_calls)) process.exit(2); if (!toolMode && schemaIndex >= 0) process.exit(2); const result = toolMode ? { type: 'result', subtype: 'success', result: '', structured_output: { content: 'Fixture says ready', tool_calls: [] } } : { type: 'result', subtype: 'success', result: input }; process.stdout.write(JSON.stringify([result])); });");
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

  const toolResponse = await chat(base, {
    model: 'workbuddy-default',
    messages,
    tools: [{ type: 'function', function: { name: 'noop' } }],
    tool_choice: 'none',
  });
  assert.equal(toolResponse.status, 200);
  assert.equal((await toolResponse.json()).choices[0].message.content, 'Fixture says ready');
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
