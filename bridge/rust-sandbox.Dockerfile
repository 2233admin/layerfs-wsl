# Rust Sandbox image for LayerFS Workspaces: omp-lfs-rust-sandbox:1
#   docker build -t omp-lfs-rust-sandbox:1 -f rust-sandbox.Dockerfile .   (inside layerfs-lab)
# Base: bench-rust-sandbox:3 = archlinux + base-devel + rustup at the host's paths, with the
# same rustc/gcc/ld as layerfs-lab, so a target/ built on one side links on the other.
FROM bench-rust-sandbox:3
# Merging two Branches whose target/ holds Cargo incremental session dirs fails in
# LayerFS 5fb68dd with "Failed: invalid record: binding kind", even with /.lww
# newer-wins rules; non-incremental target/ merges cleanly.
ENV CARGO_INCREMENTAL=0
