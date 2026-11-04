#!/bin/sh
set -eu
case "$SERVICE" in voice-agent|gateway|radio) exec node "/app/apps/$SERVICE/dist/main.js" "$@" ;; *) exit 64 ;; esac
