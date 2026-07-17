//! Integration test for the persistent Master: MANY execs (serial AND
//! concurrent) must ride ONE authentication, proven by counting "Accepted
//! publickey" lines in the throwaway sshd's VERBOSE log.

mod common;

use common::TestSshd;
use std::sync::Arc;
use std::time::Duration;

use mymux_connect::{master_exec_script, Master};

fn auth_count(log: &std::path::Path) -> usize {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .matches("Accepted publickey")
        .count()
}

#[tokio::test]
async fn master_serves_many_execs_on_one_auth() {
    let Some(sshd) = TestSshd::spawn(true) else {
        eprintln!("sshd not found — skipping master multiplex test");
        return;
    };
    let master = Master::new(sshd.cfg.clone(), None);
    for i in 0..4 {
        let out = master_exec_script(&master, &format!("echo hello-{i}"), Duration::from_secs(10))
            .await
            .expect("exec failed");
        assert!(
            out.contains(&format!("hello-{i}")),
            "missing output: {out:?}"
        );
    }
    let n = auth_count(&sshd.log);
    assert_eq!(
        n,
        1,
        "every lease must reuse the single master auth (seen {n}):\n{}",
        std::fs::read_to_string(&sshd.log).unwrap_or_default()
    );
}

#[tokio::test]
async fn master_multiplexes_concurrent_channels() {
    let Some(sshd) = TestSshd::spawn(true) else {
        eprintln!("sshd not found — skipping master multiplex test");
        return;
    };
    let master = Arc::new(Master::new(sshd.cfg.clone(), None));
    let mut handles = Vec::new();
    for i in 0..4 {
        let m = master.clone();
        handles.push(tokio::spawn(async move {
            master_exec_script(
                &m,
                &format!("sleep 0.3; echo c{i}"),
                Duration::from_secs(15),
            )
            .await
        }));
    }
    for (i, h) in handles.into_iter().enumerate() {
        let out = h.await.expect("task panicked").expect("exec failed");
        assert!(out.contains(&format!("c{i}")), "missing output: {out:?}");
    }
    let n = auth_count(&sshd.log);
    assert_eq!(
        n,
        1,
        "concurrent channels must multiplex over one auth (seen {n}):\n{}",
        std::fs::read_to_string(&sshd.log).unwrap_or_default()
    );
}
