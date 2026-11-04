FROM debian:12.12-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends icecast2 gettext-base curl && rm -rf /var/lib/apt/lists/*
COPY icecast.xml.template /etc/icecast2/icecast.xml.template
COPY --chmod=755 start.sh /start.sh
RUN mkdir -p /tmp/icecast && chown icecast2:icecast /tmp/icecast
USER icecast2
ENTRYPOINT ["/start.sh"]
