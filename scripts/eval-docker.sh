#!/usr/bin/env bash
# Runs `mithril eval` inside a locked-down Docker container.
#
#   scripts/eval-docker.sh --base-url http://localhost:11434 --model qwen3:8b --runs 3
#
# Every argument is passed to `mithril eval`, with these adjustments:
#   --base-url   http://localhost... is rewritten to host.docker.internal
#                (inside the container, "localhost" is the container itself)
#   --tasks DIR  DIR is mounted read-only into the container
#   --out, --compare, --keep-workdirs   are refused (they don't make sense here)
#
# Settings come from environment variables, so they never clash with eval's own flags:
#   MITHRIL_EVAL_RESULTS   host directory for results       (default ./eval-results)
#   MITHRIL_EVAL_IMAGE     image name                       (default mithril-eval)
#   MITHRIL_EVAL_NETWORK   run on this Docker network       (default: the normal one)
#   MITHRIL_EVAL_MEMORY    memory limit                     (default 1g)
#   MITHRIL_EVAL_CPUS      CPU limit                        (default 1)
#   MITHRIL_EVAL_REBUILD   1 = rebuild the image first
#   MITHRIL_EVAL_DRY_RUN   1 = print the docker command instead of running it
#
# MITHRIL_API_KEY / OPENAI_API_KEY are forwarded if set in your environment.
set -euo pipefail

die() {
  echo "eval-docker: $*" >&2
  exit 2
}

ROOT="${BASH_SOURCE[0]%/*}/.."
IMAGE="${MITHRIL_EVAL_IMAGE:-mithril-eval}"
RESULTS="${MITHRIL_EVAL_RESULTS:-./eval-results}"
NETWORK="${MITHRIL_EVAL_NETWORK:-}"
MEMORY="${MITHRIL_EVAL_MEMORY:-1g}"
CPUS="${MITHRIL_EVAL_CPUS:-1}"
DRY_RUN="${MITHRIL_EVAL_DRY_RUN:-0}"

if [ "$DRY_RUN" != "1" ] && ! command -v docker >/dev/null 2>&1; then
  die "docker was not found. Install Docker, or run 'npm run dev -- eval' directly if you accept the risks described in the README."
fi

# Rewrites a loopback URL so it works from inside the container. Skipped when a
# custom network is used: there the server is reached by its container name.
rewrite_url() {
  if [ -n "$NETWORK" ]; then
    printf '%s' "$1"
    return
  fi
  printf '%s' "$1" | sed -E 's#^(https?://)(localhost|127\.0\.0\.1|\[::1\])([:/]|$)#\1host.docker.internal\3#'
}

args=()
tasks_host=""
needs_model=1
have_base_url=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      die "--out is set by this script. Use MITHRIL_EVAL_RESULTS=<dir> to choose where results go." ;;
    --compare)
      die "--compare only reads results files and runs nothing, so it needs no container: run 'npm run dev -- eval --compare a.json b.json' directly." ;;
    --keep-workdirs)
      die "--keep-workdirs can't work here: scratch directories live in the container's tmpfs and disappear when it exits." ;;
    --tasks)
      [ $# -ge 2 ] || die "--tasks needs a value."
      [ -d "$2" ] || die "--tasks directory not found: $2"
      # -P resolves symlinks. On macOS the temp dir (/var/folders/...) is a
      # symlink to /private/var/folders/..., and the mount source should be the
      # real path.
      tasks_host="$(cd "$2" && pwd -P)"
      args+=(--tasks /tasks)
      shift 2 ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url needs a value."
      have_base_url=1
      rewritten="$(rewrite_url "$2")"
      if [ "$rewritten" != "$2" ]; then
        echo "eval-docker: using $rewritten inside the container (your server must listen on a non-loopback address, e.g. OLLAMA_HOST=0.0.0.0)." >&2
      fi
      args+=(--base-url "$rewritten")
      shift 2 ;;
    --help|--list|--verify-tasks)
      needs_model=0
      args+=("$1")
      shift ;;
    *)
      args+=("$1")
      shift ;;
  esac
done

if [ "$needs_model" = "1" ] && [ "$have_base_url" = "0" ]; then
  die "pass --base-url and --model. Run the model server outside the container (Ollama, LM Studio, a llamafile, ...); the container only runs the eval."
fi

# The container runs as YOUR uid/gid so results files belong to you. Running
# the script as root would make that a root container, so refuse.
if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" = "0" ]; then
  die "refusing to run as root (the container would run as root too). Run this as a normal user."
fi

cmd=(docker run --rm
  --read-only --tmpfs /tmp:rw,size=512m
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory "$MEMORY" --cpus "$CPUS"
  --user "$(id -u):$(id -g)")

if [ -n "$NETWORK" ]; then
  cmd+=(--network "$NETWORK")
else
  cmd+=(--add-host=host.docker.internal:host-gateway)
fi

# Forward API keys by NAME only: docker reads the value from this process's
# environment, so the secret never appears on a command line or in `ps`.
for var in MITHRIL_API_KEY OPENAI_API_KEY; do
  if [ -n "${!var:-}" ]; then
    cmd+=(-e "$var")
    echo "eval-docker: forwarding $var into the container. Code the model writes could read it; use a throwaway key with a spend limit." >&2
  fi
done

if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$RESULTS"
fi
# Docker bind mounts need an absolute host path (the directory may not exist yet in a dry run).
case "$RESULTS" in
  /*) RESULTS_ABS="$RESULTS" ;;
  *) RESULTS_ABS="$PWD/${RESULTS#./}" ;;
esac
cmd+=(-v "$RESULTS_ABS:/results")
if [ -n "$tasks_host" ]; then
  cmd+=(-v "$tasks_host:/tasks:ro")
fi
cmd+=("$IMAGE" "${args[@]}" --out /results)

if [ "$DRY_RUN" = "1" ]; then
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

if [ "${MITHRIL_EVAL_REBUILD:-0}" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "eval-docker: building image '$IMAGE'..." >&2
  docker build -t "$IMAGE" "$ROOT"
fi

exec "${cmd[@]}"
