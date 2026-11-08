#!/usr/bin/env bash
# Bring the desktop up after first setup or after the VM resumes. Idempotent.
# Failures go to stderr in plain words: the control plane shows that text.
set -euo pipefail
NAME=anywhere-desktop
fail() { echo "$*" >&2; exit 1; }

# After a resume, SSH can answer before the Docker daemon does.
DOCKER=
for _ in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then DOCKER=docker; break; fi
  if sudo -n docker info >/dev/null 2>&1; then DOCKER="sudo docker"; break; fi
  sleep 2
done
[ -n "$DOCKER" ] || fail "Docker is not running on the machine"

$DOCKER start "$NAME" >/dev/null || fail "The desktop container would not start"

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
# On failure, show why: the image's supervisord logs each program (Xvfb and the
# session run under "desktop").
why() {
  $DOCKER exec "$NAME" sh -c 'tail -n 15 /var/log/supervisor/desktop*.log 2>/dev/null; tail -n 5 /var/log/supervisor/supervisord.log 2>/dev/null' >&2 || true
}
XUSER=$($DOCKER exec "$NAME" stat -c %U /tmp/.X11-unix/X1 2>/dev/null) || { why; fail "The desktop's display did not start"; }

# Cua's server picks its desktop provider once, at its own start. After a resume it can
# start before Xvfb is serving and then answer every call with "no desktop provider"
# (seen live). The display is up now, so restart it to bind to the display.
$DOCKER exec "$NAME" supervisorctl restart cua-spacesd >/dev/null 2>&1 || true
launch() {
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
}
# websockify answers HTTP even when x11vnc is gone, so ask the VNC server itself
# for its "RFB" greeting.
vnc_up() {
  [ "$($DOCKER exec "$NAME" bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900 && timeout 2 head -c 3 <&3' 2>/dev/null)" = RFB ]
}

launch || fail "Could not start the desktop's VNC services"
for i in $(seq 1 40); do
  if vnc_up && curl -fs -o /dev/null http://127.0.0.1:6080/ && curl -s -o /dev/null http://127.0.0.1:3211/; then
    echo "::ready::"
    exit 0
  fi
  # x11vnc exits if it started before Xvfb was really serving (after a restart the
  # old X socket file can still be there); the launch commands are idempotent.
  if [ $((i % 5)) = 0 ]; then launch || true; fi
  sleep 1
done
why
fail "The desktop's VNC and Cua services did not come up"
