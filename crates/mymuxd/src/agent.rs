//! Agent-status endpoint. Agents report their state here (via their hooks); we
//! fold it into a pane→state map and broadcast so the UI can badge each window.
//!
//! `GET /agent?pane=<N>&state=<running|waiting|done|idle>`

use std::sync::Arc;

use axum::extract::{Query, State};
use serde::Deserialize;

use crate::tmux::Hub;

/// What an agent in a pane is doing. Absence from the map = idle / no agent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentState {
    Running,
    Waiting,
    Done,
}

impl AgentState {
    pub fn parse(s: &str) -> Option<AgentState> {
        match s {
            "running" | "busy" | "start" => Some(AgentState::Running),
            "waiting" | "notify" | "attention" | "approval" => Some(AgentState::Waiting),
            "done" | "stop" | "complete" => Some(AgentState::Done),
            _ => None, // "idle" / "clear" / unknown → clear the entry
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Running => "running",
            AgentState::Waiting => "waiting",
            AgentState::Done => "done",
        }
    }

    /// Higher = more attention-worthy, for per-window aggregation.
    pub fn priority(self) -> u8 {
        match self {
            AgentState::Waiting => 3,
            AgentState::Done => 2,
            AgentState::Running => 1,
        }
    }
}

/// Where a pane's [`AgentState`] came from. Hook reports outrank heuristics.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Source {
    Hook,
    Heuristic,
}

#[derive(Clone, Copy)]
pub struct AgentEntry {
    pub state: AgentState,
    pub source: Source,
    /// When this state was set — output arriving within a short grace period
    /// must not clear a fresh `Done` (agents often flush trailing output right
    /// after their turn-complete hook fires).
    pub set_at: std::time::Instant,
    /// When the pane FIRST became attention-worthy (waiting|done), epoch ms —
    /// the authoritative ordering for the UI's attention queue (survives UI
    /// reconnects and state coalescing; inherited across needy→needy flips).
    pub needy_since_ms: Option<u64>,
}

pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl AgentEntry {
    /// Build an entry, inheriting the needy timestamp from `prev` when the
    /// pane stays attention-worthy across the transition.
    pub fn new(state: AgentState, source: Source, prev: Option<&AgentEntry>) -> AgentEntry {
        let needy = matches!(state, AgentState::Waiting | AgentState::Done);
        let needy_since_ms = if needy {
            prev.and_then(|p| p.needy_since_ms)
                .or_else(|| Some(epoch_ms()))
        } else {
            None
        };
        AgentEntry {
            state,
            source,
            set_at: std::time::Instant::now(),
            needy_since_ms,
        }
    }
}

#[derive(Deserialize)]
pub struct AgentQuery {
    pane: u32,
    state: String,
}

pub async fn agent_handler(
    State(hub): State<Arc<Hub>>,
    Query(q): Query<AgentQuery>,
) -> &'static str {
    hub.set_agent(q.pane, AgentState::parse(&q.state));
    "ok"
}
