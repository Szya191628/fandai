'use strict';

const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const HOST = '127.0.0.1';
const PORT = 8318;
const MODEL = 'workbuddy-default';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_PROMPT_CHARS = 512 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_MESSAGES = 1000;
const TIMEOUT_MS = 120_000;
const MAX_TOOLS = 128;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    tool_calls: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: { type: 'string' } },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
  },
  required: ['content', 'tool_calls'],
  additionalProperties: false,
};
const DEFAULT_NODE = 'D:\\360Downloads\\node.exe';
const DEFAULT_CLI = 'F:\\2345下载\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';
const DEFAULT_MODEL = Object.freeze({ id: MODEL, displayName: 'WorkBuddy default', cliModel: null });
const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;

class GatewayError extends Error {
  constructor(status, type, code, message) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

function errorResponse(error) {
  const e = error instanceof GatewayError
    ? error
    : new GatewayError(502, 'server_error', 'workbuddy_cli_error', 'WorkBuddy CLI request failed');
  return { status: e.status, body: { error: { message: e.message, type: e.type, code: e.code } } };
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function authorized(header, key) {
  const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
  const supplied = match ? match[1] : '';
  const actualDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(key).digest();
  return timingSafeEqual(actualDigest, expectedDigest) && Boolean(match);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume();
      reject(new GatewayError(413, 'invalid_request_error', 'body_too_large', 'Request body exceeds 4 MiB'));
      return;
    }
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        req.resume();
        reject(new GatewayError(413, 'invalid_request_error', 'body_too_large', 'Request body exceeds 4 MiB'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('aborted', () => {
      if (done) return;
      done = true;
      reject(new GatewayError(400, 'invalid_request_error', 'request_aborted', 'Request was interrupted'));
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      reject(new GatewayError(400, 'invalid_request_error', 'invalid_request', 'Could not read request body'));
    });
  });
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validModelId(value) {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value) && !value.startsWith('-');
}

function validateCatalog(catalog, allowEmpty = false) {
  if (!Array.isArray(catalog) || (!allowEmpty && catalog.length === 0)) {
    throw new Error('models.json must contain a non-empty array');
  }
  const ids = new Set();
  return catalog.map(model => {
    if (!model || typeof model !== 'object' || Array.isArray(model) ||
        !validModelId(model.id) || model.id === MODEL ||
        typeof model.displayName !== 'string' || model.displayName.length === 0 ||
        model.displayName.length > 128 || model.displayName.trim() !== model.displayName ||
        /[\u0000-\u001f\u007f]/.test(model.displayName) ||
        !validModelId(model.cliModel) || model.cliModel !== model.id) {
      throw new Error('models.json contains an invalid model entry');
    }
    if (ids.has(model.id)) throw new Error('models.json contains duplicate model IDs');
    ids.add(model.id);
    return { id: model.id, displayName: model.displayName, cliModel: model.cliModel };
  });
}

function loadCatalog() {
  const catalogPath = join(__dirname, 'models.json');
  if (!existsSync(catalogPath)) return [];
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    throw new Error('models.json is not valid JSON');
  }
  return validateCatalog(catalog);
}

function createModelRegistry(catalog) {
  return new Map([[MODEL, DEFAULT_MODEL], ...catalog.map(model => [model.id, model])]);
}

function makePrompt(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_request', 'Request body must be a JSON object');
  }
  const registry = catalog instanceof Map
    ? catalog
    : createModelRegistry(catalog === undefined ? [] : validateCatalog(catalog));
  const selectedModel = registry.get(body.model);
  if (!selectedModel) {
    throw new GatewayError(400, 'invalid_request_error', 'model_not_supported', 'The requested model is not supported');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_request', 'stream must be a boolean');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'messages must be a non-empty array');
  }
  if (own(body, 'functions') || own(body, 'function_call')) {
    throw new GatewayError(400, 'invalid_request_error', 'unsupported_tools', 'Legacy functions and function_call are not supported');
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new GatewayError(400, 'invalid_request_error', 'too_many_messages', `At most ${MAX_MESSAGES} messages are supported`);
  }

  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_tools', `tools must contain at most ${MAX_TOOLS} function definitions`);
  }
  const toolNames = new Set();
  const normalizedTools = tools.map(tool => {
    const definition = tool && tool.type === 'function' && tool.function;
    const name = definition?.name;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition) ||
        typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name) || toolNames.has(name) ||
        (definition.description !== undefined && typeof definition.description !== 'string') ||
        (definition.parameters !== undefined && (!definition.parameters || typeof definition.parameters !== 'object' || Array.isArray(definition.parameters))) ||
        (definition.strict !== undefined && typeof definition.strict !== 'boolean')) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_tools', 'Each tool must be a uniquely named function with text description and object parameters');
    }
    if (definition.strict === true) {
      throw new GatewayError(400, 'invalid_request_error', 'unsupported_strict_tools', 'strict:true is not supported');
    }
    toolNames.add(name);
    const fn = { name };
    if (definition.description !== undefined) fn.description = definition.description;
    fn.parameters = definition.parameters ?? { type: 'object', properties: {} };
    if (definition.strict !== undefined) fn.strict = definition.strict;
    return { type: 'function', function: fn };
  });

  const toolChoice = body.tool_choice;
  let choiceMode = toolChoice === undefined ? 'auto' : toolChoice;
  let namedTool = null;
  if (typeof choiceMode === 'string') {
    if (!['none', 'auto', 'required'].includes(choiceMode)) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_tool_choice', 'tool_choice must be none, auto, required, or a named function');
    }
  } else if (choiceMode && typeof choiceMode === 'object' && !Array.isArray(choiceMode) &&
      choiceMode.type === 'function' && choiceMode.function && typeof choiceMode.function.name === 'string' &&
      TOOL_NAME_PATTERN.test(choiceMode.function.name)) {
    namedTool = choiceMode.function.name;
    choiceMode = 'named';
  } else {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_tool_choice', 'tool_choice must be none, auto, required, or a named function');
  }
  if ((choiceMode === 'required' || namedTool) && normalizedTools.length === 0) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_tool_choice', 'required and named tool_choice need declared tools');
  }
  if (namedTool && !toolNames.has(namedTool)) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_tool_choice', 'tool_choice names an undeclared function');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_tool_choice', 'parallel_tool_calls must be a boolean');
  }
  const parallelToolCalls = body.parallel_tool_calls !== false;

  let totalBytes = 0;
  const priorCallIds = new Set();
  const completedCallIds = new Set();
  const messages = body.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Each message must be an object');
    }
    const role = message.role;
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) {
      if (role !== 'tool') {
        throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Message role must be system, developer, user, assistant, or tool');
      }
    }
    if (own(message, 'function_call')) {
      throw new GatewayError(400, 'invalid_request_error', 'unsupported_tools', 'Legacy functions and function_call are not supported');
    }

    if (own(message, 'tool_calls') && role !== 'assistant') {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'tool_calls are only supported on assistant messages');
    }
    let content = message.content;
    if (content === null || content === undefined) {
      if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) content = null;
      else throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Message content is required unless an assistant message has tool_calls');
    } else if (Array.isArray(content)) {
      if (role === 'tool' || content.some(part => !part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string')) {
        throw new GatewayError(400, 'invalid_request_error', 'unsupported_content', 'Only text message content is supported');
      }
      content = content.map(part => part.text).join('');
    }
    if (typeof content !== 'string' && !(role === 'assistant' && own(message, 'tool_calls') && content === null)) {
      throw new GatewayError(400, 'invalid_request_error', 'unsupported_content', 'Only text message content is supported');
    }
    const normalizedMessage = { role, content };
    if (role === 'assistant' && own(message, 'tool_calls')) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'assistant tool_calls must be a non-empty array');
      }
      normalizedMessage.tool_calls = message.tool_calls.map(call => {
        const fn = call?.function;
        if (!call || typeof call !== 'object' || Array.isArray(call) ||
            typeof call.id !== 'string' || !call.id.trim() || call.id.trim() !== call.id || call.id.length > 128 || /[\u0000-\u001f\u007f]/.test(call.id) ||
            call.type !== 'function' || !fn || typeof fn !== 'object' || Array.isArray(fn) ||
            typeof fn.name !== 'string' || !TOOL_NAME_PATTERN.test(fn.name) || typeof fn.arguments !== 'string') {
          throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'assistant tool_calls are malformed');
        }
        let args;
        try { args = JSON.parse(fn.arguments); }
        catch { throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'tool call arguments must be a JSON object'); }
        if (!args || typeof args !== 'object' || Array.isArray(args) || priorCallIds.has(call.id)) {
          throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'tool call arguments must be a JSON object and call IDs must be unique');
        }
        priorCallIds.add(call.id);
        return { id: call.id, type: 'function', function: { name: fn.name, arguments: fn.arguments } };
      });
    }
    if (role === 'tool') {
      const callId = message.tool_call_id;
      if (typeof callId !== 'string' || !callId.trim() || callId.trim() !== callId || callId.length > 128 || /[\u0000-\u001f\u007f]/.test(callId) ||
          !priorCallIds.has(callId) || completedCallIds.has(callId) || typeof message.content !== 'string' || typeof content !== 'string' ||
          (message.name !== undefined && typeof message.name !== 'string')) {
        throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'tool result must match one preceding assistant tool call');
      }
      completedCallIds.add(callId);
      normalizedMessage.tool_call_id = callId;
      if (message.name !== undefined) normalizedMessage.name = message.name;
    }
    const countedText = role === 'tool' || own(normalizedMessage, 'tool_calls')
      ? JSON.stringify(normalizedMessage)
      : content;
    totalBytes += Buffer.byteLength(countedText, 'utf8');
    if (totalBytes > MAX_TEXT) {
      throw new GatewayError(400, 'invalid_request_error', 'text_too_large', 'Message text, tools, and tool history exceed 1 MiB');
    }
    return normalizedMessage;
  });

  if (priorCallIds.size !== completedCallIds.size) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Every assistant tool call must have one matching tool result');
  }

  if (normalizedTools.length > 0) {
    totalBytes += Buffer.byteLength(JSON.stringify(normalizedTools), 'utf8');
    if (totalBytes > MAX_TEXT) {
      throw new GatewayError(400, 'invalid_request_error', 'text_too_large', 'Message text, tools, and tool history exceed 1 MiB');
    }
  }

  const toolPrefix = normalizedTools.length > 0
    ? `Use the StructuredOutput formatter to return {content, tool_calls}; put external function requests in tool_calls and do not invoke external names as CLI built-ins. Do not claim to have executed these external functions.\nAvailable function tools:\n${JSON.stringify(normalizedTools)}\nTool choice: ${choiceMode === 'named' ? `function ${namedTool}` : choiceMode}. ${choiceMode === 'none' ? 'Return no tool calls.' : choiceMode === 'required' ? 'Return at least one declared tool call.' : choiceMode === 'named' ? 'Return at least one call to that function and no other function.' : 'Return zero or more declared tool calls.'} ${parallelToolCalls ? 'At most 8 calls may be returned.' : 'At most 1 call may be returned.'} Tool arguments must be a JSON object encoded as a JSON string and must match the selected function parameters schema.\n\n`
    : '';
  const prompt = `${toolPrefix}Continue this conversation as the assistant. Reply to the latest user message. Messages are JSON:\n${JSON.stringify(messages)}`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GatewayError(400, 'invalid_request_error', 'prompt_too_large', 'Serialized conversation exceeds the local CLI limit of 512 Ki characters');
  }
  return {
    prompt,
    stream: body.stream === true,
    model: selectedModel.id,
    cliModel: selectedModel.cliModel,
    toolMode: normalizedTools.length > 0,
    toolConfig: { tools: normalizedTools, choiceMode, namedTool, parallelToolCalls },
  };
}

function tokenCount(...values) {
  for (const value of values) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = tokenCount(usage.prompt_tokens, usage.input_tokens, usage.inputTokens);
  const output = tokenCount(usage.completion_tokens, usage.output_tokens, usage.outputTokens);
  if (input === null || output === null) return null;
  const total = tokenCount(usage.total_tokens, usage.totalTokens) ?? input + output;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

function parseCliOutput(output) {
  let events;
  try {
    events = JSON.parse(output);
  } catch {
    throw new GatewayError(502, 'server_error', 'invalid_cli_output', 'WorkBuddy CLI returned an invalid response');
  }
  if (!Array.isArray(events)) {
    throw new GatewayError(502, 'server_error', 'invalid_cli_output', 'WorkBuddy CLI returned an invalid response');
  }
  let result = null;
  for (const event of events) {
    if (event && event.type === 'result') result = event;
  }
  if (!result || result.subtype !== 'success' || result.is_error || typeof result.result !== 'string') {
    throw new GatewayError(502, 'server_error', 'workbuddy_cli_error', 'WorkBuddy CLI request failed');
  }
  let usage = normalizeUsage(result.usage);
  if (!usage) {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === 'message' && event.providerData) {
        usage = normalizeUsage(event.providerData.usage);
        if (usage) break;
      }
    }
  }
  let assistantProviderData = null;
  for (const event of events) {
    const isAssistantMessage = event && event.type === 'message' &&
      (event.message?.role === 'assistant' || event.role === 'assistant');
    if (!isAssistantMessage) continue;
    assistantProviderData = event.providerData && typeof event.providerData === 'object'
      ? event.providerData
      : null;
  }
  const actualModel = validModelId(assistantProviderData?.model) ? assistantProviderData.model : null;
  const requestModelId = validModelId(assistantProviderData?.requestModelId) ? assistantProviderData.requestModelId : null;
  return { content: result.result, structuredOutput: result.structured_output, usage, actualModel, requestModelId };
}

function validateToolOutput(completion, toolConfig) {
  const invalid = () => new GatewayError(502, 'server_error', 'invalid_tool_output', 'WorkBuddy CLI returned invalid tool output');
  const output = completion.structuredOutput;
  if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.content !== 'string' || !Array.isArray(output.tool_calls) || output.tool_calls.length > 8) {
    throw invalid();
  }
  const declaredNames = new Set(toolConfig.tools.map(tool => tool.function.name));
  const calls = output.tool_calls.map(call => {
    if (!call || typeof call !== 'object' || Array.isArray(call) ||
        typeof call.name !== 'string' || !declaredNames.has(call.name) || typeof call.arguments !== 'string') {
      throw invalid();
    }
    let args;
    try { args = JSON.parse(call.arguments); }
    catch { throw invalid(); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid();
    return { name: call.name, arguments: call.arguments };
  });
  const mode = toolConfig.choiceMode;
  if ((mode === 'none' && calls.length > 0) ||
      (mode === 'required' && calls.length === 0) ||
      (mode === 'named' && (calls.length === 0 || calls.some(call => call.name !== toolConfig.namedTool))) ||
      (!toolConfig.parallelToolCalls && calls.length > 1)) {
    throw invalid();
  }
  return { content: output.content, calls };
}

function makeToolCalls(calls) {
  return calls.map(call => ({
    id: `call_${randomUUID().replaceAll('-', '')}`,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }));
}

function killChildTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function buildCliArgs(cliPath, _prompt, model = MODEL, cliModel = null, toolOptions = {}) {
  const args = [cliPath, '-p', '--input-format', 'text', toolOptions.toolMode ? '--tools=StructuredOutput' : '--tools='];
  if (toolOptions.toolMode) args.push('--json-schema', JSON.stringify(toolOptions.toolSchema || TOOL_OUTPUT_SCHEMA));
  args.push('--strict-mcp-config', '--mcp-config', '{}', '--max-turns', '1', '--output-format', 'json', '--no-session-persistence');
  if (model !== MODEL) {
    if (!validModelId(cliModel)) throw new Error('Invalid CLI model');
    args.push('--model', cliModel);
  }
  return args;
}

function runWorkbuddyCli(prompt, { signal, nodePath, cliPath, timeoutMs, model = MODEL, cliModel = null, toolMode = false, toolSchema = TOOL_OUTPUT_SCHEMA }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GatewayError(499, 'server_error', 'client_disconnected', 'Client disconnected'));
      return;
    }
    const args = buildCliArgs(cliPath, prompt, model, cliModel, { toolMode, toolSchema });
    let timedOut = false;
    let aborted = false;
    let child;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killChildTree(child);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      child = execFile(nodePath, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (timedOut) reject(new GatewayError(504, 'server_error', 'workbuddy_timeout', 'WorkBuddy CLI request timed out'));
        else if (aborted || signal.aborted) reject(new GatewayError(499, 'server_error', 'client_disconnected', 'Client disconnected'));
        else if (error) {
          const tooLarge = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          if (tooLarge) killChildTree(child);
          reject(new GatewayError(502, 'server_error', tooLarge ? 'cli_output_too_large' : 'workbuddy_cli_error', tooLarge ? 'WorkBuddy CLI output exceeded 8 MiB' : 'WorkBuddy CLI request failed'));
        } else resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    } catch {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new GatewayError(502, 'server_error', 'workbuddy_cli_error', 'WorkBuddy CLI request failed'));
    }
  });
}

function sseChunk(res, id, created, model, delta, finishReason = null) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function createGatewayServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.WORKBUDDY_GATEWAY_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('WORKBUDDY_GATEWAY_KEY is required');
  const nodePath = options.nodePath || process.env.WB_NODE_PATH || DEFAULT_NODE;
  let cliPath = options.cliPath || process.env.WB_CLI_PATH;
  if (!cliPath || !existsSync(cliPath)) {
    cliPath = DEFAULT_CLI;
  }
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const catalog = options.models === undefined ? loadCatalog() : validateCatalog(options.models, true);
  const modelRegistry = createModelRegistry(catalog);
  const runner = options.runner || ((prompt, context) => runWorkbuddyCli(prompt, { ...context, nodePath, cliPath, timeoutMs }));
  let busy = false;

  return createServer(async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, `http://${HOST}`).pathname; }
    catch { sendJson(res, 400, { error: { message: 'Invalid URL', type: 'invalid_request_error', code: 'invalid_url' } }); return; }

    if (pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (pathname !== '/v1/models' && pathname !== '/v1/chat/completions') {
      req.resume();
      sendJson(res, 404, { error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' } });
      return;
    }
    const expectedMethod = pathname === '/v1/models' ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
      req.resume();
      res.setHeader('allow', expectedMethod);
      sendJson(res, 405, { error: { message: 'Method not allowed', type: 'invalid_request_error', code: 'method_not_allowed' } });
      return;
    }
    if (!authorized(req.headers.authorization, apiKey)) {
      req.resume();
      sendJson(res, 401, { error: { message: 'Invalid bearer token', type: 'authentication_error', code: 'invalid_api_key' } });
      return;
    }
    if (pathname === '/v1/models') {
      const data = [DEFAULT_MODEL, ...catalog].map(model => ({
        id: model.id,
        object: 'model',
        owned_by: 'workbuddy',
        display_name: model.displayName,
      }));
      sendJson(res, 200, { object: 'list', data });
      return;
    }

    let request;
    try {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); }
      catch { throw new GatewayError(400, 'invalid_request_error', 'invalid_json', 'Request body must be valid JSON'); }
      request = makePrompt(body, modelRegistry);
    } catch (error) {
      if (!res.destroyed) {
        const response = errorResponse(error);
        sendJson(res, response.status, response.body);
      }
      return;
    }

    if (busy) {
      sendJson(res, 429, { error: { message: 'Gateway is busy; retry shortly', type: 'server_error', code: 'gateway_busy' } });
      return;
    }
    busy = true;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', onClose);
    if (res.destroyed) controller.abort();
    try {
      const raw = await runner(request.prompt, {
        signal: controller.signal,
        timeoutMs,
        model: request.model,
        cliModel: request.cliModel,
        toolMode: request.toolMode,
        toolSchema: TOOL_OUTPUT_SCHEMA,
        toolConfig: request.toolConfig,
      });
      if (controller.signal.aborted || res.destroyed) return;
      let completion = parseCliOutput(raw);
      let toolCalls = null;
      if (request.toolMode) {
        const toolOutput = validateToolOutput(completion, request.toolConfig);
        completion = { ...completion, content: toolOutput.content };
        toolCalls = makeToolCalls(toolOutput.calls);
      }
      const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
      const created = Math.floor(Date.now() / 1000);
      if (!request.stream) {
        const message = {
          role: 'assistant',
          content: toolCalls?.length ? (completion.content || null) : completion.content,
        };
        if (toolCalls?.length) message.tool_calls = toolCalls;
        const body = {
          id,
          object: 'chat.completion',
          created,
          model: request.model,
          choices: [{ index: 0, message, finish_reason: toolCalls?.length ? 'tool_calls' : 'stop' }],
        };
        if (completion.usage) body.usage = completion.usage;
        if (completion.actualModel) body.workbuddy_actual_model = completion.actualModel;
        sendJson(res, 200, body);
      } else {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        sseChunk(res, id, created, request.model, { role: 'assistant' });
        if (completion.content) sseChunk(res, id, created, request.model, { content: completion.content });
        if (toolCalls?.length) {
          const deltas = toolCalls.map((call, index) => ({ index, ...call }));
          sseChunk(res, id, created, request.model, { tool_calls: deltas }, 'tool_calls');
        } else {
          sseChunk(res, id, created, request.model, {}, 'stop');
        }
        res.end('data: [DONE]\n\n');
      }
    } catch (error) {
      if (!res.destroyed && !controller.signal.aborted) {
        const response = errorResponse(error);
        sendJson(res, response.status, response.body);
      }
    } finally {
      res.removeListener('close', onClose);
      busy = false;
    }
  });
}

if (require.main === module) {
  try {
    const server = createGatewayServer();
    server.listen(PORT, HOST, () => process.stdout.write(`WorkBuddy gateway listening on http://${HOST}:${PORT}\n`));
    server.on('error', () => {
      process.stderr.write('WorkBuddy gateway failed to listen\n');
      process.exitCode = 1;
    });
  } catch {
    process.stderr.write('WorkBuddy gateway configuration is invalid; check WORKBUDDY_GATEWAY_KEY and models.json\n');
    process.exitCode = 1;
  }
}

module.exports = { createGatewayServer, makePrompt, parseCliOutput, buildCliArgs };
