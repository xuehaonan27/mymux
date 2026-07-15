//! Bake the source revision into the binary: `mymuxd --version` prints it and
//! the app's zero-touch installer compares it against the shipped bundle's
//! VERSION to decide whether a host needs a push.
fn main() {
    let rev = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    println!(
        "cargo:rustc-env=MYMUX_GIT_REV={}{}",
        rev,
        if dirty { "-dirty" } else { "" }
    );
    println!("cargo:rerun-if-changed=../../.git/HEAD");
}
