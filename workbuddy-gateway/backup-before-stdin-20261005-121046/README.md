# WorkBuddy local gateway

Exposes the signed-in WorkBuddy CLI as a small OpenAI chat completions endpoint at `http://127.0.0.1:8318/v1`. Set `WORKBUDDY_GATEWAY_KEY` before starting; the key is required for `/v1/models` and `/v1/chat/completions`. `/health` is public. Optional executable overrides are `WB_NODE_PATH` and `WB_CLI_PATH`.

The gateway accepts `workbuddy-default` plus the allowlisted models in `models.json`, and text messages only. Each catalog entry has an `id`, `displayName`, and `cliModel`; for example: `[{"id":"hy4-preview","displayName":"Hy4 preview","cliModel":"hy4-preview"}]`. The gateway validates the catalog at startup and requires a restart after it changes. If `models.json` is absent, only `workbuddy-default` is available. The default model leaves model selection to the signed-in CLI; a catalog model is passed to that request with `--model` and does not change the CLI's saved default.

The gateway does not support tools, tool choices, images, or multiple concurrent completions. `stream: true` returns OpenAI-compatible SSE after the CLI finishes; it does not stream live model tokens. Requests are limited to 256 KiB, 100 messages, 64 KiB of message text, and a 12,000-character serialized CLI prompt. Calls time out after 120 seconds; CLI output is limited to 8 MiB.

It supports one already logged-in WorkBuddy account; it does not authenticate accounts, rotate accounts, or poll for account changes. CLI use may consume account credits and uses the permissions available to that signed-in account; this gateway does not guarantee any plan entitlement. Non-streaming completions include `workbuddy_actual_model` when the CLI reports its actual provider model; the gateway does not infer that field when it is absent.

Run the local tests with `node --test test.cjs`; check syntax with `node --check gateway.cjs`.
