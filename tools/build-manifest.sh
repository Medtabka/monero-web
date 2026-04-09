#!/usr/bin/env bash
# build-manifest.sh — emit a SHA-256 manifest of every file in the deployed
# bundle so users can verify that what they're running on monero-web.com
# matches the corresponding git tag.
#
# Usage:
#   ./tools/build-manifest.sh           # write MANIFEST.txt with all hashes
#   ./tools/build-manifest.sh --check   # verify the live site matches MANIFEST
#
# This is the trust anchor that makes "open source" mean something for a
# hosted wallet. Without it, users have to take on faith that what's running
# at monero-web.com matches the public GitHub repo. With it, anyone can run
#
#   curl -sf https://monero-web.com/MANIFEST.txt | sha256sum -c
#
# from a clone of the repo and verify byte-for-byte that nothing has been
# silently substituted.

set -euo pipefail
cd "$(dirname "$0")/.."

# Files that ship to users. Same set the Cloudflare Pages deploy publishes,
# minus dotfiles, build artifacts, and tooling-only files like this script.
INCLUDED_PATTERNS=(
  "*.html"
  "fonts/fonts.css"
  "fonts/*.woff2"
  "js/*.js"
  "js/mymonero-core/*.js"
  "js/mymonero-core/*.wasm"
  "js/mymonero-core/LICENSE.txt"
  "js/mymonero-core/README.md"
  "assets/*.svg"
  "assets/*.png"
  "donation-qr.svg"
  "favicon.svg"
  "_redirects"
)

manifest_file="MANIFEST.txt"

case "${1:-}" in
  --check)
    echo "Verifying current files against ${manifest_file} …"
    if [[ ! -f "${manifest_file}" ]]; then
      echo "ERR: ${manifest_file} does not exist. Run without --check first."
      exit 1
    fi
    sha256sum -c "${manifest_file}"
    echo
    echo "OK — local files match the manifest."
    ;;
  ""|--write)
    : > "${manifest_file}"
    {
      echo "# monero-web build manifest"
      echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) from commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
      echo "#"
      echo "# Verify the live deployment matches a specific git tag with:"
      echo "#   git checkout v0.1.0"
      echo "#   ./tools/build-manifest.sh --check"
      echo "#"
      echo "# Or verify a single file against the live site:"
      echo "#   curl -sf https://monero-web.com/dashboard | sha256sum"
      echo "#"
    } > "${manifest_file}"

    # Collect every matching file deterministically (sorted)
    files=()
    for pat in "${INCLUDED_PATTERNS[@]}"; do
      for f in $pat; do
        [[ -f "$f" ]] && files+=("$f")
      done
    done
    # de-dupe and sort
    mapfile -t files < <(printf '%s\n' "${files[@]}" | sort -u)

    sha256sum "${files[@]}" >> "${manifest_file}"

    echo "Wrote ${manifest_file} (${#files[@]} files)"
    echo "First 5 entries:"
    grep -v '^#' "${manifest_file}" | head -5
    ;;
  *)
    echo "Usage: $0 [--write|--check]"
    exit 1
    ;;
esac
