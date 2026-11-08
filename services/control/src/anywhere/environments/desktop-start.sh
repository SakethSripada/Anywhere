#!/usr/bin/env bash
# Bring the desktop up after first setup or after the VM resumes. Idempotent.
set -euo pipefail
NAME=anywhere-desktop
DOCKER=docker
docker ps >/dev/null 2>&1 || DOCKER="sudo docker"

$DOCKER start "$NAME" >/dev/null

# Wait for the X display inside the container.
for _ in $(seq 1 60); do
  $DOCKER exec "$NAME" sh -c 'test -S /tmp/.X11-unix/X1' && break
  sleep 1
done

# Xvfb runs as the image's desktop user without an auth file; x11vnc must run as
# that same user (as root, `-auth guess` fails and MIT-SHM access is denied).
# Two of each run (the interactive stream and a view-only one for watch links), told
# apart by port. `pgrep -x` matches process names exactly (`pgrep -f` would match
# this very `sh -c` command line), and grep then picks the port from `-a`'s args.
XUSER=$($DOCKER exec "$NAME" stat -c %U /tmp/.X11-unix/X1)
$DOCKER exec -u "$XUSER" -d "$NAME" sh -c \
  'pgrep -a -x x11vnc | grep -q -- "-rfbport 5900" || x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 -noxdamage -quiet'
$DOCKER exec -u "$XUSER" -d "$NAME" sh -c \
  'pgrep -a -x websockify | grep -q " 6080 " || websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1'
# Watchers: input is refused by the VNC server itself (-viewonly), and the clipboard
# isn't shared (-nosel), so nothing typed or copied on the desktop leaks to them.
$DOCKER exec -u "$XUSER" -d "$NAME" sh -c \
  'pgrep -a -x x11vnc | grep -q -- "-rfbport 5901" || x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5901 -viewonly -nosel -noxdamage -quiet'
$DOCKER exec -u "$XUSER" -d "$NAME" sh -c \
  'pgrep -a -x websockify | grep -q " 6081 " || websockify 6081 127.0.0.1:5901 >/tmp/websockify-watch.log 2>&1'

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null http://127.0.0.1:6080/ && curl -s -o /dev/null http://127.0.0.1:3211/; then
    echo "::ready::"
    exit 0
  fi
  sleep 1
done
echo "::error:: Desktop services did not come up"
exit 1
