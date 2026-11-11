default:
    @just --list

# Docs, typecheck, tests, and dependency audit. CI runs this recipe.
check: docs lint test audit

# Docs are reachable through index files, and links and anchors resolve.
docs:
    python3 scripts/check_docs.py

# Typecheck the plugin.
lint:
    pnpm typecheck

# Run the plugin's tests.
test:
    pnpm test

# Check dependencies for known vulnerabilities.
audit:
    pnpm audit

# Build the plugin into dist/.
build:
    pnpm build
