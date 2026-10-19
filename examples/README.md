# Example agents

TypeScript ADK examples demonstrating Switch Trust SDK integration.

## Env setup

- Node.js >= 18
- From the SDK root (the directory that contains `package.json`): `pnpm install`

## ADK

`@google/adk` is an optional peer dependency and is not installed by `pnpm install`. Install it and the ADK dev UI in a local, uncommitted workspace inside `examples/adk`, at exact versions and without running any dependency install scripts:

```bash
cd examples/adk
echo '{ "private": true, "type": "module" }' > package.json
pnpm add --ignore-workspace --ignore-scripts --save-exact '@google/adk@1.6.0' '@google/adk-devtools@1.6.0'
```

- Configure an `.env` file that contains `SWITCH_TRUST_GATEWAY_URL` and `SWITCH_TRUST_API_KEY` per README instructions of the Switch Trust SDK. This example reads it because it passes `loadDotenv: true`; the SDK does not read `.env` unless asked (export the vars in your shell to skip the file).
- `pnpm exec adk web . --port 8501` (runs the pinned dev UI installed above), then open http://localhost:8501
- Try interacting with the agents in the ADK UI. `todo_list` routes its model calls through the guardrails gateway; `expense_tracker` does not use the SDK.

### Agents

| Agent | Guardrails | Description |
|---|---|---|
| `expense_tracker` | No | Tracks expenses in memory. Shows basic ADK agent with tools. |
| `todo_list` | Yes | Breaks tasks into steps. Demonstrates `ADKGuardrailsPlugin` integration. |

### Standalone run

```bash
npx tsx todo_list/agent.ts
```
