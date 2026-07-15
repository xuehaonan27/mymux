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
    // .git/HEAD content ("ref: refs/heads/main") doesn't change on commits —
    // watch the ref it points AT, or build.rs never re-runs and the rev
    // baked into the binary goes stale.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../../.git/HEAD") {
        if let Some(refname) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../../.git/{refname}");
        }
    }
}
