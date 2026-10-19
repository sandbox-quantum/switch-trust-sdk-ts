SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.PHONY: package-check release-audit license-check sbom vuln-scan secret-scan

CDXGEN_VERSION := 12.8.3
PUBLINT_VERSION := 0.3.23
ATTW_VERSION := 0.18.5

# ---------------------------------------------------------------------------
# Package metadata (needs a build)
# ---------------------------------------------------------------------------

# node16 profile: the package requires node >=18, so node10 resolution of the
# exports subpaths is intentionally out of scope.
package-check:
	pnpm dlx "publint@$(PUBLINT_VERSION)" --strict
	pnpm dlx "@arethetypeswrong/cli@$(ATTW_VERSION)" --pack --profile node16

# ---------------------------------------------------------------------------
# Release audit
# ---------------------------------------------------------------------------

release-audit: license-check sbom vuln-scan secret-scan
	@echo ""
	@echo "=== Release audit complete ==="
	@echo "Outputs in release/:"
	@ls -1 release/*.json 2>/dev/null
	@echo ""

# SPDX identifiers allowed for every installed package. An expression such as
# "(MIT OR Apache-2.0)" passes if one side is allowed; "A AND B" needs both.
ALLOWED_LICENSES := Apache-2.0;MIT;MIT-0;MIT-CMU;ISC;0BSD;BSD-2-Clause;BSD-3-Clause;MPL-2.0;\
Unlicense;CC0-1.0;Zlib;BSL-1.0;\
LGPL-2.0-or-later;LGPL-2.1-or-later;LGPL-3.0-or-later

# Packages whose license field is not an SPDX identifier. Manually verified:
#   (none yet)
IGNORE_PACKAGES :=

license-check:
	@mkdir -p release
	@echo "=== License review ==="
	pnpm licenses list --json > release/licenses.json
	@echo "Checking for copyleft/restricted licenses..."
	ALLOWED_LICENSES='$(ALLOWED_LICENSES)' IGNORE_PACKAGES='$(IGNORE_PACKAGES)' \
		node .github/scripts/check-licenses.mjs release/licenses.json

sbom:
	@mkdir -p release
	@echo "=== SBOM generation (CycloneDX) ==="
	pnpm dlx "@cyclonedx/cdxgen@$(CDXGEN_VERSION)" -t pnpm -o release/sbom.cdx.json
	@echo "SBOM written to release/sbom.cdx.json"

# Tier 1 (runtime) blocks on any advisory, tier 2 (dev/CI) blocks at high and
# above, tier 3 (optional peers, never installed or shipped) is report-only.
# Remediate with a dependency bump or a reviewed override in pnpm-workspace.yaml.
vuln-scan:
	@mkdir -p release
	@echo "=== Dependency vulnerability scan ==="
	@runtime=$$(node -p "Object.keys(require('./package.json').dependencies || {}).length"); \
	if [ "$$runtime" != "0" ]; then \
		echo "FAIL: the published package gained $$runtime runtime dependencies - supply-chain review required"; exit 1; \
	fi
	pnpm audit --prod --json > release/audit-prod.json \
		|| { pnpm audit --prod || true; echo "FAIL: advisory in a runtime dependency - remediate before release"; exit 1; }
	pnpm audit --dev --audit-level high --json > release/audit-dev.json \
		|| { pnpm audit --dev --audit-level high || true; echo "FAIL: dev/CI dependency advisory at high or above - remediate before release"; exit 1; }
	@echo "=== Optional peer dependency advisories (report only) ==="
	@tmp=$$(mktemp -d); \
	cp package.json pnpm-workspace.yaml "$$tmp/"; \
	sed -i.bak 's/autoInstallPeers: false/autoInstallPeers: true/' "$$tmp/pnpm-workspace.yaml"; \
	( cd "$$tmp" && pnpm install --lockfile-only >/dev/null 2>&1 && pnpm audit --json ) > release/audit-peers.json 2>/dev/null || true; \
	rm -rf "$$tmp"
	@if [ -s release/audit-peers.json ]; then \
		echo "Peer advisories written to release/audit-peers.json"; \
	else \
		echo "::warning::optional peer dependency audit did not run (pnpm install --lockfile-only failed)"; \
		echo '{"skipped": "optional peer dependency audit did not run; pnpm install --lockfile-only failed"}' > release/audit-peers.json; \
	fi

secret-scan:
	@mkdir -p release
	@echo "=== Secret scan (gitleaks) ==="
	gitleaks detect --source . --no-git --config .gitleaks.toml --redact \
		--report-path=release/gitleaks-report.json \
		--report-format=json \
		--exit-code 1 \
		|| (echo "FAIL: secrets detected — see release/gitleaks-report.json" && exit 1)
	@echo "=== Secret scan (gitleaks) - git history ==="
	gitleaks detect --source . --config .gitleaks.toml --redact \
		--report-path=release/gitleaks-history-report.json \
		--report-format=json \
		--exit-code 1 \
		|| (echo "FAIL: secrets detected in git history - see release/gitleaks-history-report.json" && exit 1)
	@echo "No secrets detected."
