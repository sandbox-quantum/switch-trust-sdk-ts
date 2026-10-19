# Switch Trust SDK (TypeScript)

Lightweight SDK for routing LLM traffic through a guardrails proxy. Wraps OpenAI, Anthropic, Google GenAI, and LangChain LLM clients, with agent framework plugins for Google ADK.

## Features

- **LLM SDK wrapping** — route LLM traffic through the Switch Trust guardrails proxy with a single `switchTrust.wrap()` call. Supports OpenAI, Anthropic, Google GenAI, and LangChain chat models.
- **Agent framework plugins** — deeper integration with agent lifecycle hooks for metadata extraction and guardrails routing. Supports Google ADK and LangChain agents (`createAgent`).
- **Plugin system** for extensibility

## Supported Integrations

Every integration package is an **optional peer dependency** — none is bundled in
the published artifact (which ships only `dist/`), and each is loaded dynamically at
runtime. Install only the ones you use.

| Integration | Category | Peer package | Supported version | Routing |
|---|---|---|---|---|
| OpenAI SDK | LLM SDK | `openai` | `^6.41.0` (≥6.41.0, <7) | `wrap()` |
| Anthropic SDK | LLM SDK | `@anthropic-ai/sdk` | `^0.100.1` (≥0.100.1, <0.101) | `wrap()` |
| Google GenAI SDK | LLM SDK | `@google/genai` | `^2.8.0` (≥2.8.0, <3) | `wrap()` |
| LangChain (`ChatOpenAI`) | LLM SDK | `@langchain/openai` | `^1.4.7` | `wrap()` |
| LangChain (`ChatAnthropic`) | LLM SDK | `@langchain/anthropic` | `^1.4.0` | `wrap()` |
| LangChain (`ChatGoogleGenerativeAI`) | LLM SDK | `@langchain/google-genai` | `^2.1.31` | `wrap()` |
| Google ADK | Agent Framework | `@google/adk` | `^1.2.0` | `ADKGuardrailsPlugin` |
| LangChain agents (`createAgent`) | Agent Framework | `langchain` | `^1.5.0` | `LangChainGuardrailsMiddleware` |
| `.env` loading (optional) | Utility | `dotenv` | `^17.4.2` | `loadDotenv` |

For the three LLM SDKs, `wrap()` also checks the installed version at runtime and
logs a warning, without failing, when it is below the minimum or at or above the
next major (`openai` 7, `@anthropic-ai/sdk` 1, `@google/genai` 3). The `^` ranges
above are the contract expressed in `peerDependencies`; consumers pick the exact
version.

## Install

```bash
npm install @sandboxaq/switch-trust-sdk-ts

# With optional peer dependencies
npm install @sandboxaq/switch-trust-sdk-ts openai          # OpenAI SDK
npm install @sandboxaq/switch-trust-sdk-ts @anthropic-ai/sdk  # Anthropic SDK
npm install @sandboxaq/switch-trust-sdk-ts @google/genai   # Google GenAI SDK
npm install @sandboxaq/switch-trust-sdk-ts @google/adk     # Google ADK (includes GenAI)
```

The base package has **no runtime `dependencies`** — installing `@sandboxaq/switch-trust-sdk-ts`
alone pulls nothing else. Add only the peer(s) for the providers you use, at a
version in the [supported range](#supported-integrations). Because peers are loaded
dynamically, a missing peer surfaces only when you actually route through that
provider (with a clear "install X" error), not at install time.

> **Peer auto-installation is intentionally disabled** for this repo
> (`autoInstallPeers: false` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml)). The
> SDK never statically imports a peer, so the dev build, typecheck, and tests do
> not need them — keeping the optional providers (and their transitive advisories)
> out of the development lockfile. To exercise the ADK or LangChain code paths
> locally, install those packages explicitly.

## Guardrails

Route all LLM traffic through the Switch Trust guardrails proxy. Create your client as usual, then call `wrap()` — it auto-detects the provider and applies guardrails routing.

### OpenAI

```typescript
import OpenAI from "openai";
import { wrap } from "@sandboxaq/switch-trust-sdk-ts";

const client = new OpenAI({ apiKey: "your-openai-api-key" });
wrap(client, {
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
  policyId: "your-policy-id",  // optional
});

const response = await client.chat.completions.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello" }],
});
```

### Anthropic

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "@sandboxaq/switch-trust-sdk-ts";

const client = new Anthropic({ apiKey: "your-anthropic-api-key" });
wrap(client, {
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
});

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});
```

### Google GenAI

```typescript
import { GoogleGenAI } from "@google/genai";
import { wrap } from "@sandboxaq/switch-trust-sdk-ts";

const client = new GoogleGenAI({ apiKey: "your-gemini-api-key" });
wrap(client, {
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
});

const response = await client.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "Hello",
});
```

### LangChain

Create your LangChain chat model as usual, then call `wrap()` — it detects the LangChain model and applies guardrails routing (gateway base URL + auth headers) to the model's client config, which the underlying provider client picks up when it is built:

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { wrap } from "@sandboxaq/switch-trust-sdk-ts";

const llm = new ChatOpenAI({ model: "gpt-4", apiKey: "your-openai-api-key" });
wrap(llm, {
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
});

const response = await llm.invoke("Hello");
```

Works with `ChatOpenAI`, `ChatAnthropic`, and `ChatGoogleGenerativeAI`.

### LangChain agents

For LangChain **agents** (`createAgent`), use `LangChainGuardrailsMiddleware` instead of `wrap()`. It routes the agent's model through the guardrails proxy and tags every model call with:

- `X-Agent-Id` / `X-Agent-Name` — from `AGENT_ID` / `AGENT_NAME` (or the `agentId` / `agentName` options).
- `X-Agent-Session-Id` — the invocation's `thread_id`.
- `X-Agent-Turn-Id` — shared by every model call of one `agent.invoke` (tool loop included) and new for each user message, so the platform shows each turn as one interaction.

> The platform derives this agent's id from `AGENT_NAME`; only set `AGENT_ID` if you're pinning the exact id shown on the agent's page — an incorrect value disconnects this agent's traffic from its evals.

```typescript
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { LangChainGuardrailsMiddleware } from "@sandboxaq/switch-trust-sdk-ts/plugins/langchain";

const plugin = new LangChainGuardrailsMiddleware({
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
});

const agent = createAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [...],
  middleware: [plugin.middleware],
});

const result = await agent.invoke(
  { messages: [{ role: "user", content: "Hello" }] },
  { configurable: { thread_id: "session-123" } },
);
```

Session and turn headers are attached to each model call, not to the model's shared client, so concurrent invocations of one agent never mix them up. Works with `ChatOpenAI`, `ChatAnthropic`, `ChatGoogleGenerativeAI`, or a model string such as `"openai:gpt-4o"`.

### Google ADK

ADK agents lazily create their GenAI client at runtime and use `generateContentConfig` for per-request routing, so `wrap()` cannot be used. Use the ADK plugin instead:

```typescript
import { ADKGuardrailsPlugin } from "@sandboxaq/switch-trust-sdk-ts/plugins/adk";
import { Agent } from "@google/adk";

const plugin = new ADKGuardrailsPlugin({
  gatewayUrl: "https://api.switchagents.ai",
  apiKey: "your-guardrails-api-key",
});

const agent = new Agent({
  model: "gemini-2.5-flash",
  generateContentConfig: plugin.contentConfig,
  beforeModelCallback: plugin.beforeModelCallback,
  onModelErrorCallback: ADKGuardrailsPlugin.onModelError,
});
```

> **Passing your own `contentConfig`:** if you supply `contentConfig: ...` to the plugin, wire `plugin.contentConfig` (not your original object) into the `Agent`. The plugin returns a clone with the guardrails `httpOptions` attached and leaves your object untouched, so passing the original sends traffic straight to the model — and with `requireGuardrails` enabled by default, `beforeModelCallback` raises.

`beforeModelCallback` attaches `X-Agent-Id` / `X-Agent-Name` (from `AGENT_ID` / `AGENT_NAME`, the name falling back to the ADK agent's own), `X-Agent-Session-Id` (the ADK session ID) and `X-Agent-Turn-Id` (ADK's invocation ID — one per user message, shared by every model call of it) on each guardrails request. `onModelErrorCallback` converts Switch Trust guardrails blocks (403 / keyword match) into an `LlmResponse` so the agent can handle them gracefully.

With `requireGuardrails` (the default), the plugin refuses an agent whose model is a `Gemini` instance created with `useInteractionsApi: true`. That path ignores `httpOptions`, so its requests cannot be routed through the gateway.

> The platform derives this agent's id from `AGENT_NAME`; only set `AGENT_ID` if you're pinning the exact id shown on the agent's page — an incorrect value disconnects this agent's traffic from its evals.

### Configuration Reference

`wrap()` and `init()` accept these guardrails parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `gatewayUrl` | `string` | Guardrails proxy URL |
| `apiKey` | `string` | Your guardrails API key |
| `policyId` | `string \| undefined` | Guardrails policy ID to apply (optional) |
| `agentName` | `string \| undefined` | Agent name used as `agentId` when no explicit `agentId` is provided |
| `agentId` | `string \| undefined` | Overrides the id the platform derives from `agentName`. Only set this to the exact id shown on the agent's page — a mismatched value breaks eval lookups for this agent. Leave unset in most cases. |
| `requireGuardrails` | `boolean \| undefined` | When `true` (default), throws `SwitchTrustGuardrailsError` if guardrails config cannot be resolved. Set to `false` to allow operation without guardrails. |
| `dangerouslyDisableGuardrails` | `boolean \| undefined` | Explicit, self-documenting opt-out equivalent to `requireGuardrails: false`. Prefer this so unguarded deployments are greppable. Cannot be combined with `requireGuardrails: true`. Either opt-out emits a once-per-process `SECURITY CONTROL DISABLED` console warning so it stays auditable. |

### Environment Variables

Instead of passing credentials in code, you can set them as environment variables:

| Environment Variable            | Parameter    | Description                                                                                                   |
|---------------------------------|--------------|---------------------------------------------------------------------------------------------------------------|
| `SWITCH_TRUST_GATEWAY_URL`           | `gatewayUrl` | Guardrails proxy URL                                                                                          |
| `SWITCH_TRUST_API_KEY`               | `apiKey`     | Your guardrails API key                                                                                       |
| `SWITCH_TRUST_POLICY_ID`             | `policyId`   | Guardrails policy ID (optional)                                                                               |
| `AGENT_ID`                      | `agentId`    | Overrides the id the platform derives from `AGENT_NAME`. Only set this to the exact id shown on the agent's page — a mismatched value breaks eval lookups for this agent. Leave unset in most cases. |
| `AGENT_NAME`                    | `agentName`  | Agent name attached to guardrails requests                                                                    |
| `SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS` | —            | Comma-separated list of allowed gateway hostnames. Default: `api.switchagents.ai`, `api.flintai.dev`, `app.flintai.dev`. The `*` wildcard requires `allowInsecureGateway: true` (see Security). |

Environment variables are read automatically. A `.env` file is **not** read by
default — pass `loadDotenv: true` to load `<cwd>/.env`, or `loadDotenv: "/path/to/.env"`
to load a specific trusted file (requires `dotenv` as a peer dependency):

```bash
# .env
SWITCH_TRUST_GATEWAY_URL=https://api.switchagents.ai
SWITCH_TRUST_API_KEY=your-guardrails-api-key
```

Then use Switch Trust SDK without passing credentials:

```typescript
import OpenAI from "openai";
import { wrap } from "@sandboxaq/switch-trust-sdk-ts";

const client = new OpenAI();
wrap(client, { loadDotenv: true });  // reads env vars + <cwd>/.env
```

**Precedence:** Explicit parameters > environment variables.

**Multiple provider keys:** If multiple provider API keys are set in the environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`), auto-detection will fail. Pass `provider` explicitly to `init()` to disambiguate.

### How It Works

1. `wrap(client, { gatewayUrl, ... })` auto-detects the provider from the client type, computes the provider-specific path prefix (`/openai`, `/anthropic`, `/gemini`), rewrites the client's base URL, and injects custom headers (`X-FlintAI-API-Key`, `X-Guardrails-Policy-Id`)
2. The Switch Trust guardrails proxy intercepts the request, applies policy checks (detectors), and strips the custom headers
3. The request continues upstream using whatever credential the client's own SDK already authenticated with — the `Authorization` header built from the `apiKey` you passed when constructing the client, or from the provider's own standard environment variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`/`GEMINI_API_KEY`) if you didn't pass one explicitly. `wrap()` never holds or forwards a separate upstream credential of its own — it only rewrites the base URL and adds the two guardrails headers from step 1.

> This is deliberate: `wrap()` has no option to pass or forward a separate upstream provider key. The upstream provider key is always whatever the client was constructed with, resolved the normal way for that provider's SDK.

**Global state:** Each `wrap()` call updates the global Switch Trust SDK client's guardrails config. If you wrap multiple clients with different parameters, each client retains its own headers and base URL, but only the last `wrap()` call's config is stored globally. For most applications (single provider, shared credentials), this is transparent.

### Known Limitations

**Private attribute mutation:** `wrap()` redirects traffic by rewriting each client's base URL and injecting the guardrails headers (`X-FlintAI-API-Key`, `X-Guardrails-Policy-Id`). For OpenAI and Anthropic this uses the public `baseURL` property plus the internal `_options.defaultHeaders`, and for Google the internal `apiClient.clientOptions.httpOptions`. The internal attributes are not part of the respective SDKs' public API and may change without notice, so pin your SDK versions to the tested ranges:

- `openai >=6.41.0,<7`
- `@anthropic-ai/sdk >=0.100.1,<1`
- `@google/genai >=2.8.0,<3`

`wrap()` resolves the installed version from each SDK's `package.json` and emits a console warning if it falls outside the tested range.

**Google GenAI URL normalization:** The Google GenAI SDK requires a trailing slash on the base URL. Switch Trust SDK normalizes this automatically — do not add a trailing slash to `gatewayUrl`.

### Security

**Fail-closed by default:** `init()` and `wrap()` throw `SwitchTrustGuardrailsError` when guardrails configuration cannot be resolved. To opt out, pass `dangerouslyDisableGuardrails: true` (preferred, self-documenting) or `requireGuardrails: false`. The opt-out is not silent: `init()`, `wrap()`, and the ADK plugin emit a `SECURITY CONTROL DISABLED` console warning (including the resolved agent identifier) — once per process — whenever guardrails are disabled, so unguarded deployments are detectable in logs/telemetry.

**Inspect the effective posture:** call `switchTrust.status()` (or `client.guardrailsStatus()`) at runtime to get `{ active, requireGuardrails, provider, agentId, agentName }`, where `active` is `true` only when traffic is actually routed through the gateway. Returns `null` before `init()`. Use this to assert protection rather than trusting the opt-out flag alone.

**HTTPS enforcement:** Gateway URLs must use `https://` for non-loopback hosts. `http://` is allowed only for loopback (`localhost`, `127.0.0.1`, `::1`) and only when `allowInsecureGateway: true` is set (with a console warning).

**Gateway host allowlist:** By default, only `api.switchagents.ai`, `api.flintai.dev` and `app.flintai.dev` are allowed as gateway hosts. Override with the `SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS` environment variable (comma-separated hostnames).

**Loopback and wildcard require an explicit code opt-in:** A loopback `gatewayUrl` and the `SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS='*'` wildcard both let a caller redirect the Switch Trust API key, provider credentials, and all prompt/response traffic to an unintended endpoint. Neither can be enabled through the environment or a `.env` file — you must pass `allowInsecureGateway: true` to `init()`/`wrap()` (intended for local development only). Requesting loopback or `*` without it throws at config time; using `*` with it also emits a console warning.

## Plugins

Plugins handle events from the Switch Trust SDK lifecycle. Extend `SwitchTrustPlugin` and override the methods you care about:

```typescript
import { init, registerPlugin, SwitchTrustPlugin } from "@sandboxaq/switch-trust-sdk-ts";

class MyPlugin extends SwitchTrustPlugin {
  name = "my-plugin";

  onInit(client) {
    console.log(`Plugin initialized with ${client}`);
  }

  onShutdown() {
    console.log("Shutting down");
  }
}

init();
registerPlugin(new MyPlugin());
```

### Plugin Methods

| Method | Called when |
|--------|-----------|
| `onInit(client)` | Plugin is registered |
| `onShutdown()` | `shutdown()` is called |

## License

Apache 2.0, as limited by a modified Commons Clause license condition. See the `LICENSE` file included in this package for the full terms.
