#!/bin/sh
set -eu
for secret in "$ICECAST_SOURCE_PASSWORD" "$ICECAST_ADMIN_PASSWORD"; do
 case "$secret" in *[!a-zA-Z0-9_-]*|'') exit 64 ;; esac
 test "${#secret}" -ge 32 || exit 64
done
envsubst '${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD}' < /etc/icecast2/icecast.xml.template > /tmp/icecast/icecast.xml
exec icecast2 -c /tmp/icecast/icecast.xml
