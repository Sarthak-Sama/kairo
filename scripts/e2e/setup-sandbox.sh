#!/usr/bin/env bash
# Create a standalone sandbox repo for MANUAL Kairo pipeline testing.
# Prints the sandbox path and the env exports needed to use the stub CLIs.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KAIRO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
CLI="$KAIRO_ROOT/dist/cli.js"

[ -f "$CLI" ] || { echo "dist/cli.js missing — run: pnpm build" >&2; exit 1; }

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/kairo-manual-XXXXXX")"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/kairo-manual-state-XXXXXX")"

cd "$SANDBOX"
mkdir -p src
cat > package.json <<'EOF'
{ "name": "manual-sandbox", "version": "0.0.0", "scripts": { "test": "node check-test.js" } }
EOF
echo 'module.exports = () => 42;' > src/app.js
echo '# manual sandbox' > README.md
cat > check-test.js <<'EOF'
console.log('check ok');
EOF
git init -q
git config user.email manual@kairo.test
git config user.name kairo-manual
git add -A && git commit -qm baseline

node "$CLI" init
node -e "
const fs = require('node:fs');
const c = JSON.parse(fs.readFileSync('.kairo/config.json', 'utf8'));
c.checks = [{ name: 'test', command: 'node check-test.js' }];
fs.writeFileSync('.kairo/config.json', JSON.stringify(c, null, 2));
"

cat <<EOF

Sandbox ready: $SANDBOX

To drive it with the STUB CLIs:
  cd $SANDBOX
  export PATH="$E2E_DIR/bin:\$PATH"
  export KAIRO_E2E_STATE_DIR="$STATE"
  export KAIRO_E2E_SCENARIO=happy_delegation   # or any scenario in run.mjs
  node $CLI run "Add a greeting feature"

To drive it with REAL CLIs (codex + claude installed): skip the exports.
EOF
