#!/usr/bin/env bash
set -euo pipefail
install_root=$1
binary_link=$2
receipt=$3
case "$install_root:$binary_link" in
  /opt/Paseo:/usr/bin/Paseo|/opt/PaseoFormatFixture:/usr/bin/PaseoFormatFixture) ;;
  *) echo 'Unexpected RPM installation paths' >&2; exit 1 ;;
esac
{
  for entry in "$install_root" "$binary_link"; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then
      ls -ld -- "$entry"
    else
      printf 'absent: %s\n' "$entry"
    fi
  done
  if [ -d "$install_root" ] && [ ! -L "$install_root" ]; then
    # Drain find so a truncated receipt cannot create a SIGPIPE failure.
    find "$install_root" -maxdepth 8 -printf '%y %u %m %p -> %l\n' |
      awk 'NR <= 200 {print} END {if (NR > 200) print "additional entries omitted:", NR - 200}'
  fi
} > "$receipt" 2>&1
cat "$receipt"
test ! -e "$install_root"
test ! -L "$install_root"
test ! -e "$binary_link"
test ! -L "$binary_link"
