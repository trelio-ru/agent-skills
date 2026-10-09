#!/usr/bin/env bash

# Run either the complete provider regression set or an exact comma-separated
# subset selected from the pull-request diff. T-Bank remains excluded because
# its dedicated PR workflow owns both required operating systems.

set -euo pipefail

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIRECTORY}/../.." && pwd)"
PYTHON_BINARY="${PYTHON_BINARY:-python3}"
# CI validates package composition with a deliberately synthetic distributable
# app identity. Only exact tagged builds receive real values from repository
# release secrets, so ordinary regressions never need them.
TELEGRAM_MTPROTO_TEST_APP_CREDENTIAL_JSON='{"api_id":"12345","api_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'

FULL_SKILL_SET=(
  document-facsimile
  email-imap-smtp
  1c-edo
  iphone-mirroring
  gosuslugi
  gas-pravosudie
  max-web
  whatsapp-web
  telegram-mtproto
  telegram-web
  consultant-plus
  dodostats-drinkitstats
)

print_usage() {
  echo "Usage: $0 [--all | --skills skill-a,skill-b]" >&2
}

is_supported_skill() {
  case "$1" in
    document-facsimile|email-imap-smtp|1c-edo|iphone-mirroring|gosuslugi|max-web|whatsapp-web|telegram-mtproto|telegram-web|consultant-plus|dodostats-drinkitstats|gas-pravosudie|ozon-buyer-search|russian-post-registered-mail)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_skill() {
  local expected="$1"
  local current
  for current in "${SELECTED_SKILLS[@]}"; do
    if [[ "${current}" == "${expected}" ]]; then
      return 0
    fi
  done
  return 1
}

# Keep the default as the historical full gate for local maintainers. CI passes
# --skills only after the selector has validated every changed provider path.
if [[ "$#" -eq 0 ]] || [[ "${1:-}" == "--all" ]]; then
  if [[ "$#" -gt 1 ]]; then
    print_usage
    exit 2
  fi
  SELECTED_SKILLS=("${FULL_SKILL_SET[@]}")
elif [[ "$#" -eq 2 ]] && [[ "$1" == "--skills" ]]; then
  IFS=',' read -r -a SELECTED_SKILLS <<< "$2"
  if [[ "${#SELECTED_SKILLS[@]}" -eq 0 ]] || [[ -z "${SELECTED_SKILLS[0]}" ]]; then
    echo "At least one selected skill is required." >&2
    exit 2
  fi
else
  print_usage
  exit 2
fi

for skill in "${SELECTED_SKILLS[@]}"; do
  if ! is_supported_skill "${skill}"; then
    echo "Unsupported provider regression selection: ${skill}" >&2
    exit 2
  fi
done

printf 'Selected provider regressions:'
printf ' %s' "${SELECTED_SKILLS[@]}"
printf '\n'

cd "${REPOSITORY_ROOT}"

if has_skill gosuslugi; then
  node platform-skills/gosuslugi/development/build-storage-codec.mjs --check
fi
if has_skill gas-pravosudie; then
  node platform-skills/gas-pravosudie/development/build-storage-codec.mjs --check
fi

if has_skill max-web; then
  npm ci --prefix platform-skills/max-web --ignore-scripts --no-audit --no-fund
fi
if has_skill whatsapp-web; then
  npm ci --prefix platform-skills/whatsapp-web --ignore-scripts --no-audit --no-fund
fi

# These repository-wide contracts are fast and validate the selected skill's
# instruction/release shape. The selector test prevents a bad routing change
# from silently shrinking future CI.
node --test \
  platform-skills/tools/agent-skill-refresh-contract.test.mjs \
  platform-skills/tools/agent-skill-setup-contract.test.mjs \
  platform-skills/tools/build-runtime-package.test.mjs \
  platform-skills/tools/local-accounts.test.mjs \
  platform-skills/tools/select-provider-regressions.test.mjs

# Every selected executable package remains deterministic before its behavior
# is tested. Instruction-only and Remote MCP providers have no package here.
for skill in "${SELECTED_SKILLS[@]}"; do
  case "${skill}" in
    document-facsimile|email-imap-smtp|1c-edo|iphone-mirroring|gosuslugi|gas-pravosudie|max-web|whatsapp-web|telegram-mtproto|telegram-web)
      ;;
    *)
      continue
      ;;
  esac

  if [[ "${skill}" == "telegram-mtproto" ]]; then
    TRELIO_TELEGRAM_APP_CREDENTIAL_JSON="${TELEGRAM_MTPROTO_TEST_APP_CREDENTIAL_JSON}" \
      node platform-skills/tools/build-runtime-package.mjs \
        --skill-dir "platform-skills/${skill}" \
        --check
  else
    node platform-skills/tools/build-runtime-package.mjs \
      --skill-dir "platform-skills/${skill}" \
      --check
  fi
done

# Python providers use only their public test entrypoints. Selection happens
# before invocation, so a MAX-only patch never starts these suites.
for skill in \
  document-facsimile \
  1c-edo \
  email-imap-smtp \
  telegram-mtproto
do
  if has_skill "${skill}"; then
    "${PYTHON_BINARY}" -m unittest discover \
      -s "platform-skills/${skill}/tests" \
      -p "test_*.py"
  fi
done

NODE_TESTS=()
has_skill consultant-plus && NODE_TESTS+=(platform-skills/consultant-plus/tests/trelio-consultant-plus.test.mjs)
has_skill gas-pravosudie && NODE_TESTS+=(platform-skills/gas-pravosudie/tests/runtime.test.mjs)
has_skill iphone-mirroring && NODE_TESTS+=(platform-skills/iphone-mirroring/tests/trelio-iphone-mirroring.test.mjs)
if has_skill gosuslugi; then
  NODE_TESTS+=(
    platform-skills/gosuslugi/tests/runtime.test.mjs
    platform-skills/gosuslugi/tests/services.test.mjs
    platform-skills/gosuslugi/tests/authorization.test.mjs
    platform-skills/gosuslugi/tests/esia-flow.test.mjs
  )
fi
has_skill max-web && NODE_TESTS+=(platform-skills/max-web/tests/trelio-max.test.mjs)
if has_skill whatsapp-web; then
  for test_file in platform-skills/whatsapp-web/tests/*.test.mjs; do
    NODE_TESTS+=("${test_file}")
  done
fi
if has_skill telegram-mtproto; then
  NODE_TESTS+=(
    platform-skills/telegram-mtproto/tests/release-input.test.mjs
    platform-skills/telegram-mtproto/tests/release-contract.test.mjs
  )
fi
has_skill telegram-web && NODE_TESTS+=(platform-skills/telegram-web/tests/trelio-telegram-web.test.mjs)
has_skill dodostats-drinkitstats && NODE_TESTS+=(platform-skills/dodostats-drinkitstats/tests/remote-mcp-contract.test.mjs)

if [[ "${#NODE_TESTS[@]}" -gt 0 ]]; then
  node --test "${NODE_TESTS[@]}"
fi

# Gosuslugi's two GUI fixtures share the real OS window manager. Keep their
# whole suites sequential so closing one browser cannot invalidate focus proof
# in the other fixture.
if has_skill gosuslugi; then
  node --test --test-concurrency=1 \
    platform-skills/gosuslugi/tests/browser-smoke.test.mjs \
    platform-skills/gosuslugi/tests/playwright-client.test.mjs
fi

if has_skill dodostats-drinkitstats; then
  node --check \
    platform-skills/dodostats-drinkitstats/development/probe_remote_mcp_live.mjs
fi
