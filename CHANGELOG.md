# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers two package names: `@sandboxaq/switch-trust-sdk-ts`, the
current name, and `@sandboxaq/flintai-sdk-ts`, the former name it was published
under for versions 0.3.0 to 0.4.1.

## @sandboxaq/switch-trust-sdk-ts

### 0.5.2

#### Security

- `ADKGuardrailsPlugin` with `requireGuardrails` (the default) now rejects a
  request config that uses snake_case `http_options`, and validates only
  `httpOptions.baseUrl`. `@google/genai` reads neither `http_options` nor
  `base_url`, so a config naming the gateway that way passed the check and was
  then sent directly to the provider, without guardrails.
- With `requireGuardrails`, `ADKGuardrailsPlugin` also refuses an agent whose
  model is a `Gemini` instance created with `useInteractionsApi: true`. That
  path ignores `httpOptions`, so its requests went directly to the provider.

#### Changed

- Updated README, tests, and examples to use api.switchagents.ai as default URL.
- The `license` field in package.json is now `SEE LICENSE IN LICENSE`, and the
  README describes the license as Apache 2.0 as limited by a modified Commons
  Clause condition. 0.5.1 shipped that LICENSE file but declared `Apache-2.0`
  in package.json. `@sandboxaq/flintai-sdk-ts` 0.4.1 and earlier were
  published under plain Apache 2.0.

### 0.5.1

#### Changed

- Renamed the npm package `@sandboxaq/flintai-sdk-ts` to
  `@sandboxaq/switch-trust-sdk-ts`.
- Renamed `FlintAIClient`, `FlintAIPlugin`, `FlintAIGuardrailsError` and
  `FlintAIInitOptions` to `SwitchTrustClient`, `SwitchTrustPlugin`,
  `SwitchTrustGuardrailsError` and `SwitchTrustInitOptions`.
- Environment variables are now `SWITCH_TRUST_GATEWAY_URL`,
  `SWITCH_TRUST_API_KEY`, `SWITCH_TRUST_POLICY_ID` and
  `SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS`. The matching `FLINTAI_*` variables are
  still read when the new ones are unset.

#### Added

- `@sandboxaq/switch-trust-sdk-ts/plugins/langchain` entry point. The ADK and
  LangChain integrations send an `X-Agent-Turn-Id` header.

#### Deprecated

- `@sandboxaq/flintai-sdk-ts` is deprecated on npm and receives no further
  releases. Use `@sandboxaq/switch-trust-sdk-ts`.

## @sandboxaq/flintai-sdk-ts (former name)

### @sandboxaq/flintai-sdk-ts 0.4.1

0.4.0 was not published to npm; its changes ship in 0.4.1.

#### Changed

- The default gateway allowlist now contains `api.flintai.dev` as well as
  `app.flintai.dev`.

#### Fixed

- ADK plugin: camelCase field names and callback signatures.
- Guardrails routing for LangChain v1.x chat models.

### @sandboxaq/flintai-sdk-ts 0.3.1

#### Changed

- README only; the built code is unchanged from 0.3.0.

### @sandboxaq/flintai-sdk-ts 0.3.0

#### Added

- First release of `@sandboxaq/flintai-sdk-ts` on npm. `wrap()` routes OpenAI,
  Anthropic, Google GenAI and LangChain chat model clients through the
  guardrails proxy, with a Google ADK plugin.
- `dangerouslyDisableGuardrails` as an explicit opt-out, logged once per process
  as `SECURITY CONTROL DISABLED`, and `status()` / `client.guardrailsStatus()` to
  inspect the effective posture.

#### Security

- A loopback `gatewayUrl` and the `*` wildcard in the allowed-hosts variable are
  rejected unless `allowInsecureGateway: true` is passed in code, and `.env` is
  read only when `loadDotenv` is set. Every published version of
  `@sandboxaq/flintai-sdk-ts` contains this.
- ADK requests are bound to the configured guardrails gateway, and the LLM
  provider API key is never sent to the gateway (no `X-LLM-API-Key` header).
