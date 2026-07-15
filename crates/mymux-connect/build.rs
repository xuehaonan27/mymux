//! Embed the self-contained daemon bundle when it exists (produced by
//! scripts/build-daemon-bundle.sh into src-tauri/resources/daemon/). When the
//! app is built WITHOUT it, the zero-touch install path reports a clear error
//! instead of failing the compile.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(daemon_bundle)");
    let dir = std::path::Path::new("../../src-tauri/resources/daemon");
    for f in ["linux-x86_64.tar.gz", "linux-x86_64.version"] {
        println!("cargo:rerun-if-changed={}", dir.join(f).display());
    }
    if dir.join("linux-x86_64.tar.gz").is_file() && dir.join("linux-x86_64.version").is_file() {
        println!("cargo:rustc-cfg=daemon_bundle");
    }
}
