#!/bin/bash
# Run scripts/build.sh inside an Ubuntu 22.04 container, for hosts that are not WSL/Linux (macOS, or Linux without
# the build dependencies). Output lands in <repo>/dist/ like a native build.
# Usage: scripts/docker-build.sh [all|kernel|musl|busybox|quickjs|guest|packages [name...]]   (build.sh's targets)
#        scripts/docker-build.sh shell                                                  (a shell in the build container)
# The build tree (LLVM, kernel, musl, ...; about 15 GB) lives in the Docker volume "winix-build", not in the repo,
# so the first build is slow (it compiles LLVM) and later ones are incremental. `docker volume rm winix-build`
# starts over. WINIX_JOBS sets LLVM's compile jobs; the default allows 2.5 GB of Docker's memory for each (some of
# clang's files need about 2 GB, and a job that runs out is killed, failing the build), so give Docker more memory
# for a faster first build.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=winix-build:22.04

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" - <<'DOCKERFILE'
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git cmake ninja-build python3 python3-pip flex bison bc rsync cpio curl ca-certificates \
      xz-utils unzip patch file gawk perl pkg-config zlib1g-dev libffi-dev libssl-dev && \
    rm -rf /var/lib/apt/lists/* && \
    git config --system --add safe.directory '*'
DOCKERFILE

mem=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
jobs=$((mem / 2684354560)); [ "$jobs" -ge 1 ] || jobs=1
tty=--interactive; [ -t 0 ] && tty=-it  # (not an array: macOS's bash 3.2 rejects an empty one under set -u)
run=(docker run --rm "$tty" -v "$REPO:/repo" -v winix-build:/root/winix-build -w /repo
  -e LW_JOBS_LLVM_COMPILE="${WINIX_JOBS:-$jobs}" -e LW_JOBS_LLVM_LINK=1 -e LW_VARIANT -e WINIX_HOST_PYTHON "$IMAGE")
if [ "${1:-}" = shell ]; then exec "${run[@]}" bash; fi
exec "${run[@]}" scripts/build.sh "$@"
