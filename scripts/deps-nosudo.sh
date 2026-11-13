#!/bin/bash
# Passwordless fallback for flex/bison/ninja on Ubuntu 22.04 (WSL). Preferred: sudo apt install -y flex bison ninja-build
set -euo pipefail
R=$HOME/.local/tooldeps; mkdir -p "$R" "$HOME/.local/bin" /tmp/winix-debs
pip3 install --user ninja
(cd /tmp/winix-debs && apt-get download flex bison m4 libfl2 && for d in *.deb; do dpkg -x "$d" "$R"; done)
printf '#!/bin/sh\nexport LD_LIBRARY_PATH=%s/usr/lib/x86_64-linux-gnu M4=%s/usr/bin/m4\nexec %s/usr/bin/flex "$@"\n' "$R" "$R" "$R" > "$HOME/.local/bin/flex"
printf '#!/bin/sh\nexport BISON_PKGDATADIR=%s/usr/share/bison M4=%s/usr/bin/m4\nexec %s/usr/bin/bison "$@"\n' "$R" "$R" "$R" > "$HOME/.local/bin/bison"
chmod +x "$HOME/.local/bin/flex" "$HOME/.local/bin/bison"
