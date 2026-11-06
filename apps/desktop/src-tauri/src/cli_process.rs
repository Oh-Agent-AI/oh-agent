//! 桌面进程拉起捆绑 `agent-vitals` 的唯一入口。
//!
//! 菜单栏二进制在 release 上是 GUI 子系统（`main.rs` 的
//! `windows_subsystem = "windows"`）。捆绑的 `agent-vitals.exe` 仍是默认控制台
//! 子系统——交互式终端要靠它附着已有控制台，不能改成 GUI 子系统来“修”闪窗。
//! Windows 上 GUI 父进程 `CreateProcess` 一个控制台子系统子进程时，会新分配
//! 一个可见控制台；stdout/stderr 管道接得住输出，但窗口在子进程重定向之前就
//! 已经建出来了，所以只 `piped()` 仍会闪一下。
//!
//! `CREATE_NO_WINDOW`（0x08000000）让这次创建不分配控制台，管道照常可用。
//! 不用 `DETACHED_PROCESS`：那个标志会丢掉标准句柄。`CREATE_UNICODE_ENVIRONMENT`
//! 是 std 在未设置 creation flags 时的默认位；spawn 时 std 会再 OR 一次
//! （Rust 1.73+，本仓库 rust-version 1.74），这里仍显式带上，避免将来有人把
//! 掩码改成“整字替换”时丢掉非 ASCII 的 `AGENT_VITALS_HOME`。

use std::path::Path;
use std::process::Command;

/// WinBase.h `CREATE_NO_WINDOW`.
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;
/// WinBase.h `CREATE_UNICODE_ENVIRONMENT`.
const WINDOWS_CREATE_UNICODE_ENVIRONMENT: u32 = 0x00000400;

pub(crate) fn windows_cli_creation_flags() -> u32 {
    WINDOWS_CREATE_NO_WINDOW | WINDOWS_CREATE_UNICODE_ENVIRONMENT
}

/// 构造一条会启动 `agent-vitals` 的 `Command`。Windows 上带
/// [`windows_cli_creation_flags`]；其它平台与 `Command::new` 相同。
pub(crate) fn cli_command(program: impl AsRef<Path>) -> Command {
    let mut command = Command::new(program.as_ref());
    hide_agent_vitals_console(&mut command);
    command
}

fn hide_agent_vitals_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_cli_creation_flags());
    }
    #[cfg(not(windows))]
    {
        let _ = (command, windows_cli_creation_flags());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn windows_cli_creation_flags_hide_console_and_keep_unicode_env() {
        let flags = windows_cli_creation_flags();
        assert_eq!(flags, 0x08000000 | 0x00000400);
        assert_eq!(flags & 0x08000000, 0x08000000);
        assert_eq!(flags & 0x00000400, 0x00000400);
        assert_eq!(flags & 0x00000008, 0);
        assert_eq!(flags & 0x00000010, 0);
    }

    #[test]
    fn spawn_site_parser_ignores_comments_and_strings() {
        let src = "fn a() {\n    // Command::new(hidden)\n    Command::new(bin)\n    let s = \"Command::new(nope)\";\n}\n";
        assert_eq!(cli_spawn_sites(src), vec![(3, "bin".to_string())]);
    }

    #[cfg(unix)]
    #[test]
    fn cli_command_keeps_stdout_on_unix() {
        let output = cli_command("/bin/echo")
            .arg("console-hidden-marker")
            .output()
            .expect("spawn echo");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "console-hidden-marker"
        );
    }

    #[test]
    fn every_desktop_process_spawn_is_cli_command_or_an_allowlisted_tool() {
        let src_dir = desktop_src_dir();
        let mut files = Vec::new();
        collect_rust_sources(&src_dir, &mut files);
        files.sort();
        assert!(!files.is_empty(), "no rust sources under {}", src_dir.display());

        let mut offenders = Vec::new();
        let mut helper_sites = 0usize;
        let mut helper_sets_flags = false;
        for path in &files {
            let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
                panic!("read {}: {e}", path.display());
            });
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == "cli_process.rs" {
                helper_sets_flags = code_sets_windows_hide_flags(&text);
            }
            for (line, arg) in cli_spawn_sites(&text) {
                if name == "cli_process.rs" && arg == "program.as_ref()" {
                    helper_sites += 1;
                    continue;
                }
                if !allowlisted_non_cli_program(&arg) {
                    offenders.push(format!("{}:{line}: Command::new({arg})", path.display()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "desktop spawn of agent-vitals must go through cli_command (CREATE_NO_WINDOW on Windows):\n{}",
            offenders.join("\n")
        );
        assert_eq!(helper_sites, 1, "cli_command must be the only Command::new in cli_process.rs");
        assert!(helper_sets_flags, "cli_command must call creation_flags(windows_cli_creation_flags())");
    }

    fn desktop_src_dir() -> PathBuf {
        let file = Path::new(file!());
        let parent = file.parent().expect("cli_process.rs has a parent");
        if parent.is_absolute() && parent.join("cli_process.rs").is_file() {
            return parent.to_path_buf();
        }
        if let Some(manifest) = option_env!("CARGO_MANIFEST_DIR") {
            let dir = PathBuf::from(manifest).join(parent);
            if dir.join("cli_process.rs").is_file() {
                return dir;
            }
        }
        let cwd = std::env::current_dir().expect("cwd");
        let dir = cwd.join(parent);
        if dir.join("cli_process.rs").is_file() {
            return dir;
        }
        panic!(
            "cannot locate desktop src from file!={} cwd={}",
            file.display(),
            cwd.display()
        );
    }

    fn collect_rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
        let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
        for entry in entries {
            let entry = entry.unwrap_or_else(|e| panic!("read_dir entry: {e}"));
            let path = entry.path();
            if path.is_dir() {
                collect_rust_sources(&path, out);
            } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    fn allowlisted_non_cli_program(arg: &str) -> bool {
        matches!(
            arg,
            "\"/usr/bin/defaults\""
                | "\"open\""
                | "\"xdg-open\""
                | "\"rundll32\""
                | "\"screencapture\""
                | "\"/bin/kill\""
                | "\"kill\""
                | "\"scutil\""
                | "\"echo\""
                | "\"sh\""
                | "\"definitely-not-a-real-binary-xyz\""
        )
    }

    fn code_sets_windows_hide_flags(src: &str) -> bool {
        let code = strip_comments_and_strings(src);
        let compact: String = code.split_whitespace().collect();
        compact.contains("creation_flags(windows_cli_creation_flags())")
    }

    fn strip_comments_and_strings(src: &str) -> String {
        let chars: Vec<char> = src.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    if chars[i] == '\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
                i = (i + 2).min(chars.len());
                continue;
            }
            if chars[i] == '"' {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 2;
                        continue;
                    }
                    if chars[i] == '"' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            out.push(chars[i]);
            i += 1;
        }
        out
    }

    fn cli_spawn_sites(src: &str) -> Vec<(usize, String)> {
        let chars: Vec<char> = src.chars().collect();
        let needle: Vec<char> = "Command::new(".chars().collect();
        let mut i = 0;
        let mut line = 1usize;
        let mut sites = Vec::new();
        while i < chars.len() {
            if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if chars[i] == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    if chars[i] == '\n' {
                        line += 1;
                    }
                    i += 1;
                }
                i = (i + 2).min(chars.len());
                continue;
            }
            if chars[i] == '"' {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        i += 1;
                        if i < chars.len() {
                            if chars[i] == '\n' {
                                line += 1;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    if chars[i] == '\n' {
                        line += 1;
                    }
                    if chars[i] == '"' {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                continue;
            }
            if chars[i] == '\n' {
                line += 1;
                i += 1;
                continue;
            }
            if chars[i..].starts_with(&needle) {
                let start_line = line;
                i += needle.len();
                let arg_start = i;
                let mut depth = 1;
                while i < chars.len() && depth > 0 {
                    if chars[i] == '\n' {
                        line += 1;
                    }
                    if chars[i] == '(' {
                        depth += 1;
                    } else if chars[i] == ')' {
                        depth -= 1;
                    }
                    i += 1;
                }
                let arg: String = chars[arg_start..i.saturating_sub(1)].iter().collect();
                let compact: String = arg.split_whitespace().collect();
                sites.push((start_line, compact));
                continue;
            }
            i += 1;
        }
        sites
    }
}
