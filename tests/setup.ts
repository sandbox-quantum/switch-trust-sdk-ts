import { shutdown } from '../src/index.js';
import { resetDotenvLoaded, resetOptOutWarned } from '../src/guardrails.js';

beforeEach(() => {
  delete process.env.SWITCH_TRUST_GATEWAY_URL;
  delete process.env.SWITCH_TRUST_API_KEY;
  delete process.env.SWITCH_TRUST_POLICY_ID;
  delete process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS;
  delete process.env.FLINTAI_GATEWAY_URL;
  delete process.env.FLINTAI_API_KEY;
  delete process.env.FLINTAI_POLICY_ID;
  delete process.env.FLINTAI_ALLOWED_GATEWAY_HOSTS;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Explicitly allowlist the benign gateway hosts the suite uses. We avoid '*'
  // here: the wildcard now requires allowInsecureGateway=true and would make
  // every test throw. Tests that exercise '*' or loopback set their own env /
  // pass allowInsecureGateway=true.
  process.env.SWITCH_TRUST_ALLOWED_GATEWAY_HOSTS =
    'api.switchagents.ai,gw.example.com,gw.env.com,guardrails.env.com,custom.host,' +
    'anything.example.com,env.example.com,explicit.com,explicit.example.com,' +
    'original.com,partial.example.com';
  resetDotenvLoaded(true);
  resetOptOutWarned();
});

afterEach(async () => {
  shutdown();
});
