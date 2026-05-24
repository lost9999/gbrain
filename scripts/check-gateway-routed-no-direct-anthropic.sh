#!/usr/bin/env bash
# CI guard: fail if gateway-routed source files reintroduce direct Anthropic
# SDK instantiation (`new Anthropic()` / `import Anthropic from '@anthropic-ai/sdk'`
# as a runtime constructor, NOT a type-only import).
#
# Why this exists: v0.35.5.0 migrated src/core/think/index.ts from `new Anthropic()`
# to a gateway.chat() adapter (closed #952). v0.41+ wave did the same for
# src/core/cycle/synthesize.ts (T5 in the community PR wave). Both files
# now route through src/core/ai/gateway.ts so any provider with a registered
# recipe (Anthropic, DeepSeek, OpenRouter, Voyage, Ollama, llama-server, ...)
# is reachable via `models.dream.synthesize_verdict` / chat model config.
#
# Without this guard, a future contributor adding `import Anthropic from
# '@anthropic-ai/sdk'` and `new Anthropic()` to either file silently re-opens
# the same provider-lock-in bug class. The symptom is "my DeepSeek config
# isn't being used by dream synthesize" — invisible until first user report.
#
# Mirrors the pattern of scripts/check-jsonb-pattern.sh.
#
# Usage: scripts/check-gateway-routed-no-direct-anthropic.sh
# Exit:  0 when clean, 1 when a guarded file imports the SDK as a runtime value.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# Files whose contract is "ALL chat calls route through gateway.chat()".
# Extend this list when migrating another file off direct SDK construction.
GUARDED_FILES=(
  "src/core/cycle/synthesize.ts"
  "src/core/think/index.ts"
)

FAILED=0

for f in "${GUARDED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    # File was renamed or removed. Don't fail loud — flag and continue.
    echo "WARN: guarded file missing: $f (rename/remove? update GUARDED_FILES in $(basename "$0"))"
    continue
  fi

  # Match `new Anthropic(...)` — the runtime constructor call. Both `new Anthropic()`
  # and `new Anthropic({apiKey: '...'})` shapes are caught.
  # Exclude single-line `//` and block `*` comment lines so historical references
  # in JSDoc / explanatory comments don't false-fire. Code AND code-in-template
  # literals still hit (those don't start with `//` or ` *`).
  if grep -En 'new\s+Anthropic\s*\(' "$f" 2>/dev/null | grep -vE '^[0-9]+:\s*(//|\*)' | grep .; then
    echo
    echo "ERROR: $f reintroduced direct Anthropic SDK construction (\`new Anthropic()\`)."
    echo "       This file's contract is to route all chat calls through gateway.chat()."
    echo "       Use the adapter pattern from src/core/think/index.ts:tryBuildGatewayClient"
    echo "       or src/core/cycle/synthesize.ts:makeJudgeClient."
    FAILED=1
  fi

  # Match any value-shaped (NOT type-only) import of the SDK. The type-only form
  # `import type Anthropic from '@anthropic-ai/sdk'` is allowed for typing the
  # adapter's Anthropic.Message return shape. Covers:
  #   import Anthropic from '@anthropic-ai/sdk'         (default)
  #   import { Anthropic } from '@anthropic-ai/sdk'     (named)
  #   import Anthropic, { Other } from '@anthropic-ai/sdk' (default + named)
  #   import { Anthropic as A } from '@anthropic-ai/sdk' (named-renamed)
  #   import * as Anthropic from '@anthropic-ai/sdk'    (namespace)
  #   const x = await import('@anthropic-ai/sdk')       (dynamic)
  # Excludes ONLY the explicit type-only form `import type ... from '@anthropic-ai/sdk'`.
  if grep -En "^\s*import\s+[^t][^y]*from\s+['\"]@anthropic-ai/sdk['\"]" "$f" 2>/dev/null \
     | grep -v "^[0-9]\+:\s*import\s\+type\s" \
     | grep .; then
    echo
    echo "ERROR: $f imports @anthropic-ai/sdk as a runtime value."
    echo "       Use \`import type Anthropic from '@anthropic-ai/sdk'\` for type-only"
    echo "       references to Anthropic.Message / Anthropic.MessageCreateParamsNonStreaming."
    echo "       Route runtime chat calls through src/core/ai/gateway.ts."
    FAILED=1
  fi
  # Dynamic import — also a value-shaped reference.
  if grep -En "import\s*\(\s*['\"]@anthropic-ai/sdk['\"]" "$f" 2>/dev/null \
     | grep -vE '^[0-9]+:\s*(//|\*)' | grep .; then
    echo
    echo "ERROR: $f dynamically imports @anthropic-ai/sdk."
    echo "       Route runtime chat calls through src/core/ai/gateway.ts."
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  exit 1
fi

echo "OK: gateway-routed files have no direct Anthropic SDK construction"
echo "    (guarded: ${GUARDED_FILES[*]})"
