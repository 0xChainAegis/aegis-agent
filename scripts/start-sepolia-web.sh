#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
llm_mode="live"
check_only=0

usage() {
  printf '%s\n' \
    'Usage: bash scripts/start-sepolia-web.sh [--llm live|off] [--check]' \
    '' \
    'Defaults to Sepolia with the live model configured in contracts/.env.llm.' \
    'Use --llm off to test the chain and wallet without an AI API key.'
}

while (($#)); do
  case "$1" in
    --llm)
      if (($# < 2)) || [[ "$2" != 'live' && "$2" != 'off' ]]; then
        printf '%s\n' 'Expected --llm live or --llm off.' >&2
        exit 2
      fi
      llm_mode="$2"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

chain_env="$project_root/contracts/.env"
llm_env="$project_root/contracts/.env.llm"
deployment="$project_root/contracts/deployments/sepolia.json"

if [[ ! -f "$chain_env" ]]; then
  printf 'Missing %s; configure the Sepolia RPC and executor first.\n' "$chain_env" >&2
  exit 1
fi
if [[ ! -f "$deployment" ]]; then
  printf 'Missing %s; deploy the Sepolia contracts first.\n' "$deployment" >&2
  exit 1
fi
if [[ "$llm_mode" == 'live' && ! -f "$llm_env" ]]; then
  printf 'Missing %s; copy contracts/.env.llm.example and paste your API key.\n' "$llm_env" >&2
  exit 1
fi

set -a
# These files are private local configuration and are intentionally ignored by Git.
source "$chain_env"
if [[ -f "$llm_env" ]]; then source "$llm_env"; fi
set +a

rpc_url="${AEGIS_RPC_URL:-${RPC_URL:-}}"
if [[ -z "$rpc_url" ]]; then
  printf '%s\n' 'RPC_URL or AEGIS_RPC_URL is required in contracts/.env.' >&2
  exit 1
fi
if [[ "$llm_mode" == 'live' && -z "${AEGIS_LLM_API_KEY:-}" ]]; then
  printf '%s\n' 'AEGIS_LLM_API_KEY is empty; paste the DeepSeek key into contracts/.env.llm or use --llm off.' >&2
  exit 1
fi

export AEGIS_MODE='testnet'
export AEGIS_CHAIN_ID='11155111'
export AEGIS_DEPLOYMENT_FILE="$deployment"
export AEGIS_RPC_URL="$rpc_url"
export AEGIS_LLM_MODE="$llm_mode"

arguments=(--network sepolia --llm "$llm_mode")
if ((check_only)); then arguments+=(--check); fi
cd -- "$project_root"
exec python3 scripts/start-live-web.py "${arguments[@]}"
