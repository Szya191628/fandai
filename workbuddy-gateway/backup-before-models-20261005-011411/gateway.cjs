'use strict';

const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = 8318;
const MODEL = 'workbuddy-default';
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 64 * 1024;
const MAX_PROMPT_CHARS = 12_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_MESSAGES = 100;
const TIMEOUT_MS = 120_000;
const DEFAULT_NODE = 'D:\\360Downloads\\node.exe';
const DEFAULT_CLI = 'F:\\2345下载\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy';

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
      reject(new GatewayError(413, 'invalid_request_error', 'body_too_large', 'Request body exceeds 256 KiB'));
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
        reject(new GatewayError(413, 'invalid_request_error', 'body_too_large', 'Request body exceeds 256 KiB'));
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

function makePrompt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_request', 'Request body must be a JSON object');
  }
  if (body.model !== MODEL) {
    throw new GatewayError(400, 'invalid_request_error', 'model_not_supported', 'Only model "workbuddy-default" is supported');
  }
  if (['tools', 'tool_choice', 'functions', 'function_call'].some(key => own(body, key))) {
    throw new GatewayError(400, 'invalid_request_error', 'unsupported_parameter', 'Tool calling is not supported');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_request', 'stream must be a boolean');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'messages must be a non-empty array');
  }
  if (body.messages.length > MAX_MESSAGES) {
    throw new GatewayError(400, 'invalid_request_error', 'too_many_messages', 'At most 100 messages are supported');
  }

  let totalBytes = 0;
  const messages = body.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Each message must be an object');
    }
    if (['tool_calls', 'function_call'].some(key => own(message, key)) || message.role === 'tool') {
      throw new GatewayError(400, 'invalid_request_error', 'unsupported_parameter', 'Tool messages are not supported');
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_messages', 'Message role must be system, developer, user, or assistant');
    }

    let content = message.content;
    if (Array.isArray(content)) {
      content = content.map(part => {
        if (part && typeof part === 'object' &&
            (part.type === 'image' || part.type === 'image_url' || own(part, 'image_url'))) {
          throw new GatewayError(400, 'invalid_request_error', 'unsupported_image', 'Image inputs are not supported');
        }
        if (!part || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
          throw new GatewayError(400, 'invalid_request_error', 'unsupported_content', 'Only text message content is supported');
        }
        return part.text;
      }).join('');
    }
    if (typeof content !== 'string') {
      throw new GatewayError(400, 'invalid_request_error', 'unsupported_content', 'Only text message content is supported');
    }
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TEXT) {
      throw new GatewayError(400, 'invalid_request_error', 'text_too_large', 'Message text exceeds 64 KiB');
    }
    return { role: message.role, content };
  });

  const prompt = `Continue this conversation as the assistant. Reply to the latest user message. Messages are JSON:\n${JSON.stringify(messages)}`;
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new GatewayError(400, 'invalid_request_error', 'prompt_too_large', 'Serialized conversation exceeds the local CLI limit of 12,000 characters');
  }
  return {
    prompt,
    stream: body.stream === true,
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
  return { content: result.result, usage };
}

function killChildTree(child) {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function runWorkbuddyCli(prompt, { signal, nodePath, cliPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new GatewayError(499, 'server_error', 'client_disconnected', 'Client disconnected'));
      return;
    }
    const args = [cliPath, '-p', prompt, '--tools=', '--strict-mcp-config', '--mcp-config', '{}', '--max-turns', '1', '--output-format', 'json', '--no-session-persistence'];
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
    } catch {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new GatewayError(502, 'server_error', 'workbuddy_cli_error', 'WorkBuddy CLI request failed'));
    }
  });
}

function sseChunk(res, id, created, delta, finishReason = null) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function createGatewayServer(options = {}) {
  const apiKey = options.apiKey ?? process.env.WORKBUDDY_GATEWAY_KEY;
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('WORKBUDDY_GATEWAY_KEY is required');
  const nodePath = options.nodePath || process.env.WB_NODE_PATH || DEFAULT_NODE;
  const cliPath = options.cliPath || process.env.WB_CLI_PATH || DEFAULT_CLI;
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
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
      sendJson(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'workbuddy' }] });
      return;
    }

    let request;
    try {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); }
      catch { throw new GatewayError(400, 'invalid_request_error', 'invalid_json', 'Request body must be valid JSON'); }
      request = makePrompt(body);
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
      const raw = await runner(request.prompt, { signal: controller.signal, timeoutMs });
      if (controller.signal.aborted || res.destroyed) return;
      const completion = parseCliOutput(raw);
      const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
      const created = Math.floor(Date.now() / 1000);
      if (!request.stream) {
        const body = {
          id,
          object: 'chat.completion',
          created,
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: completion.content }, finish_reason: 'stop' }],
        };
        if (completion.usage) body.usage = completion.usage;
        sendJson(res, 200, body);
      } else {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        sseChunk(res, id, created, { role: 'assistant' });
        if (completion.content) sseChunk(res, id, created, { content: completion.content });
        sseChunk(res, id, created, {}, 'stop');
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
    process.stderr.write('WORKBUDDY_GATEWAY_KEY must be set before startup\n');
    process.exitCode = 1;
  }
}

module.exports = { createGatewayServer, makePrompt, parseCliOutput };
