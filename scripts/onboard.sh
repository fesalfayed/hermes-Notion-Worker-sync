#!/usr/bin/env bash
# hermes-projects-sync — interactive onboarding bootstrap
# Goal: `git clone` → first sync in < 3 minutes.
#
# Idempotent + non-destructive: re-running is safe. Never overwrites .env
# without explicit confirmation. Works on macOS, Linux, and WSL.
#
# Usage:
#   bash scripts/onboard.sh           # interactive
#   bash scripts/onboard.sh --yes     # accept all defaults, skip prompts
#   bash scripts/onboard.sh --no-install   # skip npm install
#
set -euo pipefail

# ---------- pretty printing ---------------------------------------------------
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
fi

step()  { printf "\n${BOLD}${BLUE}▸ %s${RESET}\n" "$*"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$*"; }
fail()  { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; }
info()  { printf "  ${DIM}%s${RESET}\n" "$*"; }
ask()   { printf "${CYAN}?${RESET} %s " "$*"; }

# ---------- flags -------------------------------------------------------------
ASSUME_YES=0
DO_INSTALL=1
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes)        ASSUME_YES=1 ;;
    --no-install)    DO_INSTALL=0 ;;
    --no-build)      DO_BUILD=0 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "Unknown flag: $arg"; exit 2 ;;
  esac
done

confirm() {
  local prompt="$1" default="${2:-N}" reply
  if [[ "$ASSUME_YES" == "1" ]]; then return 0; fi
  ask "$prompt [${default}]"
  read -r reply || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# ---------- platform sniff ----------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
IS_WSL=0
if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi

OPENER=""
case "$OS" in
  Darwin)            OPENER="open" ;;
  Linux)
    if [[ "$IS_WSL" == "1" ]] && command -v wslview >/dev/null 2>&1; then
      OPENER="wslview"
    elif command -v xdg-open >/dev/null 2>&1; then
      OPENER="xdg-open"
    fi
    ;;
esac

# ---------- repo root ---------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

printf "${BOLD}hermes-projects-sync onboarding${RESET}  ${DIM}(repo: %s)${RESET}\n" "$REPO_ROOT"
info "Platform: $OS$( [[ $IS_WSL == 1 ]] && printf ' (WSL)')"

# ---------- 1. node version --------------------------------------------------
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install Node ≥ 22 (https://nodejs.org or \`brew install node\`)."
  exit 1
fi
NODE_RAW="$(node -v)"           # e.g. v22.11.0
NODE_MAJOR="${NODE_RAW#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if (( NODE_MAJOR < 22 )); then
  fail "Node $NODE_RAW found; this repo requires Node ≥ 22 (see package.json engines)."
  info "Try: nvm install 22 && nvm use 22"
  exit 1
fi
ok "node $NODE_RAW"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found (should ship with Node)."
  exit 1
fi
ok "npm $(npm -v)"

# ---------- 2. npm install ---------------------------------------------------
step "Installing dependencies"
if [[ "$DO_INSTALL" == "0" ]]; then
  warn "--no-install passed; skipping"
elif [[ -d node_modules && -f package-lock.json && node_modules -nt package-lock.json ]]; then
  ok "node_modules is up to date"
else
  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund || npm install --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  ok "dependencies installed"
fi

# ---------- 3. ntn CLI -------------------------------------------------------
step "Checking @notionhq/cli (ntn)"

# After a fresh install ntn may land in a dir not yet on PATH for this session.
# Probe common locations before concluding ntn is absent.
_probe_ntn_path() {
  for _d in "/usr/local/bin" "$HOME/.local/bin" "$HOME/bin"; do
    if [[ -x "$_d/ntn" ]]; then
      export PATH="$_d:$PATH"
      return 0
    fi
  done
  return 1
}

if ! command -v ntn >/dev/null 2>&1; then
  _probe_ntn_path 2>/dev/null || true
fi

if command -v ntn >/dev/null 2>&1; then
  ok "ntn $(ntn --version 2>/dev/null | head -1)"
else
  warn "ntn not on PATH"
  if confirm "Install Notion CLI (ntn) via curl installer?" "Y"; then
    _NTN_LOG="$(mktemp)"
    if curl -fsSL https://ntn.dev | bash >"$_NTN_LOG" 2>&1; then
      export PATH="/usr/local/bin:$PATH"
      ok "ntn installed to /usr/local/bin"
    else
      info "/usr/local/bin not writable — retrying with \$HOME/.local/bin …"
      mkdir -p "$HOME/.local/bin"
      if curl -fsSL https://ntn.dev | NTN_INSTALL_DIR="$HOME/.local/bin" bash; then
        export PATH="$HOME/.local/bin:$PATH"
        ok "ntn installed to \$HOME/.local/bin"
        warn "ntn is on PATH for this session only. To make it permanent:"
        info "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
      else
        cat "$_NTN_LOG" >&2
        fail "ntn installation failed. Install manually:"
        info "  curl -fsSL https://ntn.dev | NTN_INSTALL_DIR=\"\$HOME/.local/bin\" bash"
      fi
    fi
    rm -f "$_NTN_LOG"
  else
    info "Install ntn manually later: curl -fsSL https://ntn.dev | NTN_INSTALL_DIR=\"\$HOME/.local/bin\" bash"
  fi
fi

# ---------- 4. .env ----------------------------------------------------------
step "Configuring .env"
ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"

INTEGRATIONS_URL="https://www.notion.so/profile/integrations/internal"

write_env_var() {
  # write_env_var KEY VALUE  -- adds or updates without clobbering other lines
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]] && grep -qE "^${key}=" "$ENV_FILE"; then
    # portable in-place edit (no GNU sed -i quirks)
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' \
        "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

prompt_value() {
  # prompt_value KEY "Human label" -- for non-secret IDs (input is echoed)
  local key="$1" label="$2" current="" val=""
  if [[ -f "$ENV_FILE" ]]; then
    current="$(awk -F= -v k="$key" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE" || true)"
  fi
  if [[ -n "$current" ]]; then
    ok "$key already set"
    return 0
  fi
  printf "\n  ${BOLD}%s${RESET}\n" "$label"
  if [[ "$ASSUME_YES" == "1" ]]; then
    warn "  --yes mode: leaving $key blank, fill it in later"
    write_env_var "$key" ""
    return 0
  fi
  ask "    Paste $key (or press Enter to skip):"
  if read -r val; then true; else val=""; fi
  if [[ -n "$val" ]]; then
    write_env_var "$key" "$val"
    ok "$key saved to .env"
  else
    write_env_var "$key" ""
    warn "$key left blank; edit .env later before running syncs that need it"
  fi
}

prompt_token() {
  # prompt_token KEY "Human label" "help URL (optional)"
  local key="$1" label="$2" url="${3:-}" current="" val=""
  if [[ -f "$ENV_FILE" ]]; then
    current="$(awk -F= -v k="$key" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE" || true)"
  fi
  if [[ -n "$current" && "$current" != "***"* && "$current" != "" ]]; then
    ok "$key already set (len=${#current})"
    return 0
  fi
  printf "\n  ${BOLD}%s${RESET}\n" "$label"
  if [[ -n "$url" ]]; then
    info "Get one at: $url"
    if [[ -n "$OPENER" ]] && confirm "    Open the page in your browser now?" "Y"; then
      "$OPENER" "$url" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$ASSUME_YES" == "1" ]]; then
    warn "  --yes mode: leaving $key blank, fill it in later"
    write_env_var "$key" ""
    return 0
  fi
  ask "    Paste $key (or press Enter to skip):"
  # read silently when possible
  if read -rs val; then printf "\n"; else val=""; fi
  if [[ -n "$val" ]]; then
    write_env_var "$key" "$val"
    ok "$key saved to .env"
  else
    write_env_var "$key" ""
    warn "$key left blank; edit .env later before running syncs that need it"
  fi
}

if [[ -f "$ENV_FILE" ]]; then
  ok ".env already exists — will only fill missing keys (no overwrite)"
else
  if [[ -f "$ENV_EXAMPLE" ]]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok ".env created from .env.example"
  else
    : > "$ENV_FILE"
    ok ".env created (empty)"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

prompt_token "NOTION_API_TOKEN"   "Notion internal integration token (ntn_…)"  "$INTEGRATIONS_URL"
prompt_token "DISCORD_BOT_TOKEN"  "Discord bot token (needed for Discord syncs/tools)"  "https://discord.com/developers/applications"
prompt_value "DISCORD_GUILD_ID"   "Discord server (guild) ID — right-click your server → Copy Server ID"
prompt_value "DISCORD_PROJECTS_CATEGORY_ID" "Discord Projects category ID — right-click the category → Copy Category ID"
prompt_value "DISCORD_ARCHIVE_CATEGORY_ID"  "Discord Archive category ID — right-click the category → Copy Category ID"
prompt_token "GITHUB_TOKEN"       "GitHub PAT with gist scope (only needed for tasks gist pipeline)"  "https://github.com/settings/tokens?type=beta"
prompt_value "KANBAN_TASKS_GIST_ID" "Gist ID for the kanban tasks snapshot (only needed for tasksDelta/tasksBackfill)"

# ---------- 5. build ---------------------------------------------------------
step "Building the worker"
if [[ "$DO_BUILD" == "0" ]]; then
  warn "--no-build passed; skipping"
else
  if npm run --silent build; then
    ok "tsc succeeded → dist/"
  else
    fail "Build failed. Fix errors above, then re-run: npm run onboard"
    exit 1
  fi
fi

# ---------- 6. summary -------------------------------------------------------
NOTION_OK="no";   grep -qE '^NOTION_API_TOKEN=.+' "$ENV_FILE" 2>/dev/null && NOTION_OK="yes"
DISCORD_OK="no";  grep -qE '^DISCORD_BOT_TOKEN=.+' "$ENV_FILE" 2>/dev/null && DISCORD_OK="yes"
GITHUB_OK="no";   grep -qE '^GITHUB_TOKEN=.+' "$ENV_FILE" 2>/dev/null && GITHUB_OK="yes"

printf "\n${BOLD}${GREEN}✓ Onboarding complete${RESET}\n\n"
printf "  ${BOLD}Env status:${RESET}  NOTION=%s  DISCORD=%s  GITHUB=%s\n" "$NOTION_OK" "$DISCORD_OK" "$GITHUB_OK"

cat <<EOF

${BOLD}Next steps:${RESET}

  ${DIM}# 1. Run a local sync to verify everything is wired up:${RESET}
  ntn workers exec projectsFromDiscord --local   ${DIM}# needs DISCORD_BOT_TOKEN + Discord IDs${RESET}

  ${DIM}# 2. Deploy to Notion cloud (first run links the worker):${RESET}
  ntn workers deploy

  ${DIM}# 3. Watch runs:${RESET}
  ntn workers runs list --limit 10

${DIM}Docs:${RESET}  README.md  ·  AGENTS.md  ·  docs/architecture.md
${DIM}Re-run anytime:${RESET}  npm run onboard
EOF
