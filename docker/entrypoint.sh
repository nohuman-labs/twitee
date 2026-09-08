#!/bin/sh
set -eu

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
until xdpyinfo -display :99 >/dev/null 2>&1; do sleep 0.1; done
fluxbox -display :99 >/dev/null 2>&1 &
x11vnc -display :99 -listen 127.0.0.1 -no6 -rfbportv6 -1 -forever -shared -nopw -rfbport 5900 >/dev/null 2>&1 &
websockify 127.0.0.1:6081 127.0.0.1:5900 >/dev/null 2>&1 &

exec node /app/dist/index.js
