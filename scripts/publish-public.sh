#!/usr/bin/env bash
# ============================================================================
# W FLOW — copy the code to the public GitHub repository.
#
# This repository stays private: it keeps the full history and the internal
# files listed in .publicignore (working notes, marketing plan, …). The public
# repository gets a clean copy of the last commit without those files and
# without the private history, so nothing removed here (or ever committed
# here) can leak through old commits.
#
# Run from the project folder (Git Bash on Windows works):
#   bash scripts/publish-public.sh            # prepare and show what changes
#   bash scripts/publish-public.sh --push     # … and push it
#
# PUBLIC_REPO_URL overrides the target (default github.com/Pidagogg/wflow).
# Only committed files are published — commit first.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUBLIC_REPO_URL="${PUBLIC_REPO_URL:-https://github.com/Pidagogg/wflow.git}"
MIRROR="$ROOT/.public-mirror"
PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes — commit them first; only committed files are published." >&2
  exit 1
fi

# ---- the public checkout (kept between runs, git-ignored) ----
if [ ! -d "$MIRROR/.git" ]; then
  rm -rf "$MIRROR"
  if git ls-remote "$PUBLIC_REPO_URL" >/dev/null 2>&1; then
    git clone --quiet "$PUBLIC_REPO_URL" "$MIRROR"
  else
    echo "Cannot reach $PUBLIC_REPO_URL — create the empty repository on GitHub first." >&2
    exit 1
  fi
fi
git -C "$MIRROR" fetch --quiet origin || true
# publish to the public repository's default branch (GitHub: main)
BRANCH="$(git ls-remote --symref "$PUBLIC_REPO_URL" HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD|\1|p')"
BRANCH="${BRANCH:-main}"
if git -C "$MIRROR" rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  git -C "$MIRROR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  git -C "$MIRROR" checkout --quiet --orphan "$BRANCH" 2>/dev/null || true
fi

# ---- replace its files with this commit, minus the private paths ----
find "$MIRROR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$MIRROR"
while IFS= read -r line; do
  path="${line%%#*}"
  path="$(echo "$path" | sed 's/[[:space:]]*$//')"
  [ -z "$path" ] && continue
  case "$path" in /*|*..*) echo "Skipping unsafe path in .publicignore: $path" >&2; continue ;; esac
  rm -rf "${MIRROR:?}/$path"
done < .publicignore

# ---- refuse to publish anything that looks like a secret ----
if grep -rIl --exclude-dir=.git -E "(sk_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=[:space:]]{40,})" "$MIRROR" >/dev/null; then
  echo "A file in the public copy looks like it holds a real key — stopping:" >&2
  grep -rIl --exclude-dir=.git -E "(sk_live_|whsec_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_|GOCSPX-)" "$MIRROR" >&2 || true
  exit 1
fi
for f in .env data deploy/vps.env; do
  [ -e "$MIRROR/$f" ] && { echo "Refusing to publish $f." >&2; exit 1; }
done

cd "$MIRROR"
git add -A
if git diff --cached --quiet; then
  echo "The public repository is already up to date."
  exit 0
fi
SUBJECT="$(git -C "$ROOT" log -1 --format=%s)"
# public commits carry GitHub's no-reply address, never the private e-mail
PUBLIC_AUTHOR_NAME="${PUBLIC_AUTHOR_NAME:-Pidagogg}"
PUBLIC_AUTHOR_EMAIL="${PUBLIC_AUTHOR_EMAIL:-208719119+Pidagogg@users.noreply.github.com}"
git -c user.name="$PUBLIC_AUTHOR_NAME" -c user.email="$PUBLIC_AUTHOR_EMAIL" \
  commit --quiet -m "$SUBJECT"
echo "==> Prepared: $SUBJECT"
git show --stat --format= HEAD | tail -3
if [ "$PUSH" = 1 ]; then
  git push --quiet origin "$BRANCH"
  echo "==> Pushed to $PUBLIC_REPO_URL"
else
  echo "Not pushed. Run again with --push to publish."
fi
