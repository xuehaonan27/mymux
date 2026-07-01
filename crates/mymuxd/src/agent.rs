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
}

#[derive(Deserialize)]
pub struct AgentQuery {
    pane: u32,
    state: String,
}

pub async fn agent_handler(State(hub): State<Arc<Hub>>, Query(q): Query<AgentQuery>) -> &'static str {
    hub.set_agent(q.pane, AgentState::parse(&q.state));
    "ok"
}
