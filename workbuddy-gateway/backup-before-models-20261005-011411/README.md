# WorkBuddy local gateway

Exposes the signed-in WorkBuddy CLI as a small OpenAI chat completions endpoint at `http://127.0.0.1:8318/v1`. Set `WORKBUDDY_GATEWAY_KEY` before starting; the key is required for `/v1/models` and `/v1/chat/completions`. `/health` is public. Optional executable overrides are `WB_NODE_PATH` and `WB_CLI_PATH`.

The gateway accepts only `workbuddy-default` and text messages. It does not support tools, tool choices, images, or multiple concurrent completions. `stream: true` returns OpenAI-compatible SSE after the CLI finishes; it does not stream live model tokens. Requests are limited to 256 KiB, 100 messages, 64 KiB of message text, and a 12,000-character serialized CLI prompt. Calls time out after 120 seconds; CLI output is limited to 8 MiB.

The gateway does not pass a model name to the CLI, so the active WorkBuddy CLI default is used (currently verified as `hy4-preview`). It supports one already logged-in WorkBuddy account; it does not authenticate accounts, rotate accounts, or poll for account changes. CLI use may consume account credits and uses the permissions available to that signed-in account; this gateway does not guarantee any plan entitlement.

Run the local tests with `node --test test.cjs`; check syntax with `node --check gateway.cjs`.
