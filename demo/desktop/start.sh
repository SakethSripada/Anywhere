#!/bin/sh
Xvfb :1 -screen 0 1600x900x24 -nolisten tcp &
sleep 1
eval "$(dbus-launch --sh-syntax)"
xfwm4 >/tmp/xfwm.log 2>&1 &
xfdesktop >/tmp/xfdesktop.log 2>&1 &
xfce4-panel >/tmp/panel.log 2>&1 &
x11vnc -display :1 -forever -shared -nopw -rfbport 5900 -quiet -noxdamage >/tmp/vnc.log 2>&1 &
websockify 6080 localhost:5900 >/tmp/ws.log 2>&1 &
exec python3 /opt/agent.py
