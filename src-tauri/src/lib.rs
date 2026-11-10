pub mod api;
pub mod browser;
pub mod core;
pub mod model;

#[cfg(feature = "desktop")]
pub mod desktop;

pub type Result<T> = std::result::Result<T, String>;
