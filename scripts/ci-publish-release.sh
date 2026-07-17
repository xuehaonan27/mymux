#!/usr/bin/env bash
# ci-publish-release.sh — create a release for the matrix artifacts and upload
# them. Tag is created SERVER-SIDE by the release API (target_commitish) — no
# local git mutation at all.
#
# Usage:
#   TAG=v0.1.0-abc1234 scripts/ci-publish-release.sh
#
# Inputs (env):
#   TAG           — release tag (required; e.g. v0.1.0-<sha7>)
#   PROVIDER      — gitea (default) | github
#   GITEA_REPO    — owner/name (defaults: XueHaonan/mymux on gitea,
#                   xuehaonan27/mymux on github)
#   GITEA_BASE    — instance URL (default: https://gitea.aka.cy /
#                   https://github.com)
#   GITEA_TOKEN   — api token (falls back to .secret/gitea_token.env locally;
#                   CI passes ${ secrets.GITEA_TOKEN/GITHUB_TOKEN })
#   ART           — artifacts dir (default: release/artifacts)
#   DRY_RUN=1     — print the plan, write nothing
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ART="${ART:-$ROOT/release/artifacts}"
PROVIDER="${PROVIDER:-gitea}"
case "$PROVIDER" in
    gitea)
        GITEA="${GITEA_BASE:-https://gitea.aka.cy}"
        REPO="${GITEA_REPO:-XueHaonan/mymux}"
        API_HOST="$GITEA"
        API_PREFIX="/api/v1/repos/$REPO"
        UPLOAD_HOST="$GITEA"
        ;;
    github)
        GITEA="${GITEA_BASE:-https://github.com}"
        REPO="${GITEA_REPO:-xuehaonan27/mymux}"
        API_HOST="https://api.github.com"
        API_PREFIX="/repos/$REPO"
        UPLOAD_HOST="https://uploads.github.com"
        ;;
    *) die() { printf 'mymux-ci: %s\n' "$*" >&2; exit 1; }; die "PROVIDER must be gitea|github (got $PROVIDER)" ;;
esac
TAG="${TAG:?TAG is required (e.g. TAG=v0.1.0-$(git -C "$ROOT" rev-parse --short HEAD))}"
note() { printf 'mymux-ci: %s\n' "$*"; }
die() { printf 'mymux-ci: %s\n' "$*" >&2; exit 1; }

[ -f "$ART/bundles.json" ] || die "no $ART/bundles.json — run scripts/ci-build-daemon-matrix.sh first"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
if [ -z "${GITEA_TOKEN:-}" ] && [ -f "$ROOT/.secret/gitea_token.env" ]; then
    set -a; . "$ROOT/.secret/gitea_token.env"; set +a
fi
[ -n "${GITEA_TOKEN:-}" ] || die "GITEA_TOKEN missing"
AUTH=(-H "Authorization: token $GITEA_TOKEN")
JSON=(-H 'content-type: application/json')
API="$API_HOST$API_PREFIX"

# 1. Roll the release's download base into bundles.json BEFORE uploading it.
TAGBASE="$GITEA/$REPO/releases/download/$TAG"
TAGBASE="$TAGBASE" ART="$ART" python3 - <<'PY'
import json, os
p = os.path.join(os.environ["ART"], "bundles.json")
d = json.load(open(p))
d["baseUrl"] = os.environ["TAGBASE"]
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
note "bundles.json baseUrl → $TAGBASE"

FILES=(linux-x86_64.tar.gz linux-aarch64.tar.gz linux-x86_64.version linux-aarch64.version SHA256SUMS bundles.json)
for f in "${FILES[@]}"; do
    [ -f "$ART/$f" ] || die "artifact missing: $ART/$f"
done

if [ "${DRY_RUN:-0}" = "1" ]; then
    note "DRY RUN: would create release $TAG @ $SHA on $GITEA/$REPO with ${#FILES[@]} assets"
    exit 0
fi

# 2. Create the release (or adopt an existing same-tag one — idempotent).
BODY=$(printf 'daemon bundle artifacts (%s)\n\nBuilt by scripts/ci-build-daemon-matrix.sh; the mymux app downloads bundles.json on first contact and installs per-host-arch.' "$SHA")
RESP="$(curl -sf -X POST "${AUTH[@]}" "${JSON[@]}" -d "$(python3 -c 'import json,sys; print(json.dumps({"tag_name": sys.argv[1], "target_commitish": sys.argv[2], "name": sys.argv[1], "body": sys.argv[3], "draft": False, "prerelease": True}))' "$TAG" "$SHA" "$BODY")" \
    "$API/releases" || true)"
ID="$(printf '%s' "$RESP" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); print(d.get("id") or "")' 2>/dev/null || true)"
if [ -z "$ID" ]; then
    note "release exists for $TAG already — adopting it"
    ID="$(curl -sf "${AUTH[@]}" "$API/releases/tags/$TAG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
fi
[ -n "$ID" ] || die "could not create/adopt release $TAG"
note "release id $ID"

# 3. Upload assets.
for f in "${FILES[@]}"; do
    if [ "$PROVIDER" = "github" ]; then
        # GITHUB_TOKEN CAN upload but CANNOT delete release assets (403 on the
        # delete endpoint — so a rerun must TOLERATE the duplicate: a 422
        # "already_exists" means the same-named asset from the first attempt
        # stays, which for a same-commit rebuild is byte-equivalent anyway.
        if curl -sf -X POST "${AUTH[@]}" -H 'content-type: application/octet-stream' \
            --data-binary "@$ART/$f" "$UPLOAD_HOST$API_PREFIX/releases/$ID/assets?name=$f" >/dev/null; then
            note "uploaded $f"
        else
            # try delete first (works when the runner token DOES permit it),
            # then fall back to accepting the pre-existing asset.
            AID="$(curl -sf "${AUTH[@]}" "$API/releases/$ID/assets" | python3 -c 'import json,sys
name=sys.argv[1]
for a in json.load(sys.stdin):
    if a.get("name")==name: print(a.get("id")); break' "$f" 2>/dev/null || true)"
            deleted=""
            if [ -n "$AID" ]; then
                if curl -sf -X DELETE "${AUTH[@]}" "$API/releases/$ID/assets/$AID" >/dev/null 2>&1; then
                    deleted=1
                fi
            fi
            if [ -n "$deleted" ]; then
                curl -sf -X POST "${AUTH[@]}" -H 'content-type: application/octet-stream' \
                    --data-binary "@$ART/$f" "$UPLOAD_HOST$API_PREFIX/releases/$ID/assets?name=$f" >/dev/null \
                    && note "uploaded $f (after delete)" || die "upload of $f failed even after delete"
            else
                note "kept the previously uploaded $f (duplicate name, identical content class)"
            fi
        fi
    else
        # Gitea: multipart attachment, delete-then-upload (works with the user token).
        AID="$(curl -sf "${AUTH[@]}" "$API/releases/$ID/assets" | python3 -c 'import json,sys
name=sys.argv[1]
for a in json.load(sys.stdin):
    if a.get("name")==name: print(a.get("id")); break' "$f" 2>/dev/null || true)"
        if [ -n "$AID" ]; then
            curl -sf -X DELETE "${AUTH[@]}" "$API/releases/$ID/assets/$AID" >/dev/null
        fi
        curl -sf -X POST "${AUTH[@]}" -F "attachment=@$ART/$f" "$UPLOAD_HOST$API_PREFIX/releases/$ID/assets?name=$f" >/dev/null
        note "uploaded $f"
    fi
done

note "release: $GITEA/$REPO/releases/tag/$TAG"
note "manifest: $TAGBASE/bundles.json"
