# Per-submission server image. Build context: the submission's /server directory (see build.sh).
ARG KIT_TAG
FROM rsdb-kit/builder:${KIT_TAG} AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/target \
    cargo build --release --locked -p rsdb-server \
 && cp /target/release/rsdb-server /rsdb-server

FROM rsdb-kit/runtime:${KIT_TAG}
COPY --from=build /rsdb-server /usr/local/bin/rsdb-server
