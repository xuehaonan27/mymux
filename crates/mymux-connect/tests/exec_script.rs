//! Integration test for `exec_script`: drives a THROWAWAY sshd on a high port
//! via the shared harness in tests/common — the user's real ssh setup is never
//! touched. Skips silently when sshd or ssh-keygen is unavailable.

mod common;

use common::TestSshd;
use std::time::Duration;

use mymux_connect::{exec_bytes, exec_script};

#[tokio::test]
async fn exec_script_runs_commands_over_ssh() {
    let Some(sshd) = TestSshd::spawn(false) else {
        eprintln!("sshd not found — skipping exec_script integration test");
        return;
    };
    let cfg = &sshd.cfg;

    // stdout + stderr are both collected; exit 0 → Ok.
    let out = exec_script(
        cfg,
        None,
        "echo hello-out; echo hello-err >&2; exit 0",
        Duration::from_secs(20),
    )
    .await
    .expect("exec_script should succeed");
    assert!(out.contains("hello-out"), "missing stdout: {out:?}");
    assert!(out.contains("hello-err"), "missing stderr: {out:?}");

    // Non-zero exit → Err carrying the code and the output tail.
    let err = exec_script(cfg, None, "echo doomed; exit 3", Duration::from_secs(20))
        .await
        .expect_err("exit 3 must be an error");
    let msg = format!("{err:?}");
    assert!(msg.contains("exited 3"), "missing exit code: {msg}");
    assert!(msg.contains("doomed"), "missing output tail: {msg}");

    // Stdin is really piped: the script can read what we send.
    let out = exec_script(
        cfg,
        None,
        "read x; echo \"got:$x\"",
        Duration::from_secs(20),
    )
    .await
    .expect("read should succeed");
    assert!(out.contains("got:"), "stdin roundtrip failed: {out:?}");

    // Binary stdin: 1 MiB lands byte-intact (exercises packet chunking).
    let bytes: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
    let out = exec_bytes(
        cfg,
        None,
        "cat | sha256sum",
        &bytes,
        Duration::from_secs(30),
    )
    .await
    .expect("binary upload should succeed");
    // sha256 of `(0..1_000_000).map(|i| (i % 251) as u8)`, precomputed.
    const WANT: &str = "2c030d49ec131bfbbb446ad21e7a2f12cdb4f2f4f3fda3ac709dd2e68a4646c7";
    assert!(out.contains(WANT), "binary roundtrip corrupted: {out}");
}
