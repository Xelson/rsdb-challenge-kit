# Kit image rsdb-kit/builder: the Rust toolchain and the only system packages available to a server build (SPEC §3).
FROM rust:1.99.1-slim-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config cmake clang libclang-dev protobuf-compiler git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rustup component add rustfmt clippy
# A rust-toolchain.toml inside the submission cannot select another toolchain.
ENV RUSTUP_TOOLCHAIN=1.99.1 CARGO_TERM_COLOR=never CARGO_TARGET_DIR=/target
