# Rust Sandbox image for LayerFS Workspaces (tested as omp-lfs-rust-sandbox:2).
#
# Build inside the distro, from a context folder holding a copy of the host's crate
# registry (cp -r /root/.cargo/registry <ctx>/registry):
#   docker build -t omp-lfs-rust-sandbox:2 -f rust-sandbox.Dockerfile <ctx>
#
# The Sandbox must match the host that builds target/ trees: the same Arch userland
# (gcc/ld; Debian's older gcc failed to link host-built C objects) and the host's
# absolute RUSTUP_HOME/CARGO_HOME paths (Cargo fingerprints registry crates by absolute
# path, so other paths rebuild every crate).
#
# Cargo builds incrementally (target/*/incremental). LayerFS before e49d1613f (the
# 5fb68dd bundle) cannot merge two Branches whose target/ holds such builds ("Failed:
# invalid record: binding kind"); with that bundle, use omp-lfs-rust-sandbox:1, which
# sets CARGO_INCREMENTAL=0.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed base-devel git rustup && pacman -Scc --noconfirm
ENV RUSTUP_HOME=/root/.rustup CARGO_HOME=/root/.cargo PATH=/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/bin
RUN rustup toolchain install stable --profile minimal -c rustfmt -c clippy -c llvm-tools-preview \
 && rustup default stable && mkdir -p /root/.cargo/bin
COPY registry /root/.cargo/registry
RUN chmod a+rx /root && chmod -R a+rwX /root/.cargo /root/.rustup && rustc -V && cargo -V
