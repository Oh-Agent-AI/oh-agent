// 不显示 console 窗口（Windows）。macOS 无影响。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_vitals_menubar_lib::run()
}
