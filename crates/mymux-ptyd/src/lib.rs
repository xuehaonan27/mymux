//! mymux-ptyd library surface: the terminal grid, the wire protocol, and the
//! client used by mymuxd. The binary (`main.rs`) is the holder daemon itself.

pub mod client;
pub mod grid;
pub mod proto;
