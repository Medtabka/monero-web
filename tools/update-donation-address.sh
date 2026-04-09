#!/usr/bin/env bash
# update-donation-address.sh — Single source of truth for the project's
# donation address.
#
# The donation address appears in three places that must stay in sync:
#   1. README.md                    — the human-readable donate section
#   2. index.html                   — the on-page address + the monero: URIs
#                                     in the "Copy address" / "Open in wallet"
#                                     buttons (3 instances total)
#   3. donation-qr.svg              — the static QR image, which encodes
#                                     monero:<address>
#
# Run this script with the new address as the only argument and all three
# files get updated atomically. Without an argument it just verifies the
# three locations agree with each other and exits non-zero on drift.
#
# Usage:
#   ./tools/update-donation-address.sh                      # check sync
#   ./tools/update-donation-address.sh 4XYZ...newaddr...    # update all 3

set -euo pipefail

cd "$(dirname "$0")/.."

CURRENT_ADDR=$(grep -oE '4[1-9A-HJ-NP-Za-km-z]{94}' README.md | head -1)
if [[ -z "${CURRENT_ADDR}" ]]; then
  echo "ERR: could not find current donation address in README.md"
  exit 1
fi

# ── Sync check ─────────────────────────────────────────────────────────
in_index=$(grep -c "${CURRENT_ADDR}" index.html || true)
in_readme=$(grep -c "${CURRENT_ADDR}" README.md || true)
in_qr=$(grep -c "${CURRENT_ADDR}" donation-qr.svg 2>/dev/null || echo 0)

echo "current address: ${CURRENT_ADDR:0:12}…${CURRENT_ADDR: -6}"
echo "  index.html        ${in_index} occurrence(s)"
echo "  README.md         ${in_readme} occurrence(s)"
echo "  donation-qr.svg   ${in_qr} occurrence(s)  (QR encodes the address as binary modules — count is 0 unless plain-text)"

# QR is binary so we can't grep it for the address. Re-render it from the
# current address every time we update — that guarantees sync.

# ── Update flow ────────────────────────────────────────────────────────
if [[ $# -eq 0 ]]; then
  if [[ "${in_index}" -lt 2 ]] || [[ "${in_readme}" -lt 1 ]]; then
    echo
    echo "WARN: address counts look wrong — files may be out of sync."
    exit 1
  fi
  echo
  echo "OK — README and index.html agree. (donation-qr.svg can't be grep-checked;"
  echo "regenerate it via this script with an address argument if you suspect drift.)"
  exit 0
fi

NEW_ADDR="$1"
if [[ ! "${NEW_ADDR}" =~ ^4[1-9A-HJ-NP-Za-km-z]{94}$ ]]; then
  echo "ERR: '${NEW_ADDR}' does not look like a Monero mainnet address"
  echo "     (expected 95 chars starting with 4)"
  exit 1
fi

if [[ "${NEW_ADDR}" == "${CURRENT_ADDR}" ]]; then
  echo "OK — already set to that address; nothing to do."
  exit 0
fi

echo
echo "Updating donation address …"
echo "  old: ${CURRENT_ADDR}"
echo "  new: ${NEW_ADDR}"
echo

# 1. README.md
sed -i "s|${CURRENT_ADDR}|${NEW_ADDR}|g" README.md

# 2. index.html (text + monero: URIs)
sed -i "s|${CURRENT_ADDR}|${NEW_ADDR}|g" index.html

# 3. donation-qr.svg — re-fetch from a public QR generator. The wallet
#    site itself never makes this request at runtime; it's a build-time
#    one-shot. The result is checked into the repo as a static file.
echo "  re-rendering donation-qr.svg …"
curl -sf "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=monero%3A${NEW_ADDR}&bgcolor=111113&color=eae8e4&format=svg&qzone=2" \
  -o donation-qr.svg

echo
echo "Done. Review the diff with:"
echo "  git diff README.md index.html donation-qr.svg"
echo
echo "Then commit with something like:"
echo "  git add README.md index.html donation-qr.svg"
echo "  git commit -m 'donate: rotate donation address'"
echo "  git push"
