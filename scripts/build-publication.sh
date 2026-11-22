#!/usr/bin/env bash
# Build a SANITIZED publication candidate in a separate directory (final audit H04). Never touches this repository's
# history: the candidate gets a fresh one-commit history built from `git archive <rev>` minus EXCLUDE.txt, plus a
# PROVENANCE.md recording the exact source revision. Nothing is pushed or published.
#   bash scripts/build-publication.sh [rev=HEAD] [target=../frontdesk-v3.2-publication]
set -euo pipefail
cd "$(dirname "$0")/.."
REV=$(git rev-parse "${1:-HEAD}^{commit}")
TARGET=${2:-../frontdesk-v3.2-publication}
if [[ -e "$TARGET" ]] && [[ -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then echo "refusing: $TARGET exists and is not empty"; exit 2; fi
mkdir -p "$TARGET"
git archive --format=tar "$REV" | tar -x -C "$TARGET"
EXCLUDED=()
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  path="${line%% # *}"; reason="${line#* # }"
  rm -rf "${TARGET:?}/$path"
  EXCLUDED+=("- \`$path\` — $reason")
done < infrastructure/publish/EXCLUDE.txt
{
  echo "# Provenance"
  echo
  echo "This repository is a sanitized publication snapshot of the private development repository."
  echo
  echo "- Source revision: \`$REV\`"
  echo "- Snapshot created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Method: \`git archive $REV\` minus the paths below (scripts/build-publication.sh); the private history is not published."
  echo "- Release checks (CI, Security, release gate) run against THIS repository's own commit SHAs."
  echo
  echo "## Withheld paths"
  echo
  printf '%s\n' "${EXCLUDED[@]}"
  echo
  echo "Some engineering documents refer to the withheld assessment PDF by name; it is intentionally not included."
} > "$TARGET/PROVENANCE.md"
# Fail closed if anything sensitive survived.
cd "$TARGET"
bad=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  p="${line%% # *}"; [[ -e "$p" ]] && { echo "LEAK: excluded path present: $p"; bad=1; }
done < "$OLDPWD/infrastructure/publish/EXCLUDE.txt"
if find . -type f \( -name '*.pdf' -o -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.dump' -o -name '*.key' -o -name '*.pem' -o -name 'credentials*.json' -o -name 'cosign.*' \) | grep -q .; then
  echo "LEAK: forbidden file types present:"; find . -type f \( -name '*.pdf' -o -name '.env' -o -name '*.dump' -o -name '*.key' -o -name '*.pem' -o -name 'credentials*.json' -o -name 'cosign.*' \); bad=1
fi
# Personal markers are derived at runtime (never written into the repository): home path, git email, hostname.
for marker in "$HOME/" "$(git -C "$OLDPWD" config user.email)" "$(hostname -s)"; do
  [[ -n "$marker" ]] && grep -rIlF -- "$marker" . && { echo "LEAK: local personal information present"; bad=1; }
done
if grep -rIlE '/Users/[A-Za-z0-9._-]+/' . ; then echo "LEAK: local absolute user path present"; bad=1; fi
[[ $bad -eq 0 ]] || { echo "publication candidate REJECTED"; exit 1; }
git init -q -b main
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" -c user.email="${PUBLICATION_AUTHOR_EMAIL:-$(git -C "$OLDPWD" config user.email)}" \
  commit -q -m "Frontdesk V3.2 — sanitized publication snapshot of ${REV:0:12}" -m "See PROVENANCE.md."
echo "candidate: $(pwd) commit $(git rev-parse HEAD) files $(git ls-files | wc -l | tr -d ' ')"
