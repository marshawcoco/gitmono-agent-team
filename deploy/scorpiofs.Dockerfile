# syntax=docker/dockerfile:1

# Mirrors the Dockerfile pinned in submodules/scorpiofs. The entrypoint is
# normalized to LF so the build also works after a Windows autocrlf checkout.
FROM rust:slim-bookworm AS build
WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libclang-dev \
        libfuse3-dev \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY submodules/scorpiofs/ .
RUN cargo build --locked --release --bin scorpio --bin antares

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fuse3 \
        libssl3 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/scorpio /usr/local/bin/scorpio
COPY --from=build /src/target/release/antares /usr/local/bin/antares
COPY submodules/scorpiofs/deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

COPY submodules/scorpiofs/scorpio.toml.example /etc/scorpiofs/scorpio.toml

ENV SCORPIO_WORKSPACE=/var/lib/scorpiofs/mount \
    SCORPIO_STORE_PATH=/var/lib/scorpiofs/store \
    SCORPIO_CONFIG_FILE=/var/lib/scorpiofs/config.toml \
    SCORPIO_ANTARES_UPPER_ROOT=/var/lib/scorpiofs/antares/upper \
    SCORPIO_ANTARES_CL_ROOT=/var/lib/scorpiofs/antares/cl \
    SCORPIO_ANTARES_MOUNT_ROOT=/var/lib/scorpiofs/antares/mnt \
    SCORPIO_ANTARES_STATE_FILE=/var/lib/scorpiofs/antares/state.toml

EXPOSE 2725

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:2725/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve", "--http-addr", "0.0.0.0:2725"]
