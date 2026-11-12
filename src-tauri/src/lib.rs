pub mod api;
#[cfg(any(all(windows, feature = "desktop"), test))]
mod audio;
#[cfg(any(feature = "desktop", test))]
mod backup;
pub mod browser;
pub mod core;
pub mod model;
mod thumbnails;

#[cfg(feature = "desktop")]
pub mod desktop;

pub type Result<T> = std::result::Result<T, String>;
