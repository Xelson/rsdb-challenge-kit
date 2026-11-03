# Kit image rsdb-kit/runtime: base of every server image. tini forwards signals; iproute2 provides tc for peer delay.
FROM debian:trixie-20261027-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 tini procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY node-entrypoint.sh /usr/local/bin/rsdb-node
VOLUME /data
EXPOSE 7700 7701
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/rsdb-node"]
