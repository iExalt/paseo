#!/bin/bash
# Legacy RPM removers run after the new install hook and delete shared integration.
exec /bin/bash /opt/Paseo/resources/linux-after-install.sh
