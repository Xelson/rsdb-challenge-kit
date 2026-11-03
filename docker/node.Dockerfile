# Kit image rsdb-kit/node: Node 24 for building the SDK, the conformance runner and the load generators.
# Kit dependencies live in /node_modules, so code under /kit resolves them; the judge links
# /node_modules/@rsdb/client -> /sdk at run time.
FROM node:24.22.2-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates iproute2 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json /
RUN cd / && npm ci --no-audit --no-fund && mkdir -p /node_modules/@rsdb
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
