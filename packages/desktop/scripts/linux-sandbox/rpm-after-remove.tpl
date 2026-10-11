#!/bin/bash
# RPM passes the number of package versions remaining after this removal.
case "$1" in
  ''|*[!0-9]*) echo 'Expected RPM remaining-package count' >&2; exit 1 ;;
esac
case "$1" in *[1-9]*) exit 0 ;; esac

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
  rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
