#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hotdeal_collector::desktop::run();
}
