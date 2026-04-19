// 跨模块共享的工具函数和全局常量。
// 进程管理、路径解析、代理配置、CLI 版本检测、事件发射等通用能力。

use crate::types::*;
use serde_json::Value;
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

pub const DEFAULT_NODE_BINARY: &str = "node";
pub const DEFAULT_OPENCODE_BINARY: &str = "opencode";
pub const DEFAULT_CODEX_BINARY: &str = "codex";
pub const DEFAULT_CLAUDE_BINARY: &str = "claude";
pub const DEFAULT_GEMINI_BINARY: &str = "gemini";
pub const CLI_VERIFY_TIMEOUT: Duration = Duration::from_secs(20);
pub const CLI_VERSION_TIMEOUT: Duration = Duration::from_secs(5);
pub const CLI_STREAM_EVENT: &str = "designcode://cli-output";
pub const MENU_ACTION_EVENT: &str = "designcode://menu-action";
pub const CODEX_APP_SERVER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const CODEX_TURN_TIMEOUT: Duration = Duration::from_secs(1800);
pub const GEMINI_ACP_READY_TIMEOUT: Duration = Duration::from_secs(45);
pub const OPENCODE_READY_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

pub fn trim_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

pub fn configure_background_command(command: &mut Command) {
    #[cfg(not(target_os = "windows"))]
    let _ = command;

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn command_version<S: AsRef<OsStr>>(binary: S, flag: &str, cwd: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    command
        .arg(flag)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .and_then(|child| wait_child_output_with_timeout(child, CLI_VERSION_TIMEOUT).ok())
        .filter(|output| output.status.success())
        .map(|output| trim_output(&output.stdout))
        .filter(|value| !value.is_empty())
}

pub fn command_version_with_args(
    binary: &Path,
    leading_args: &[String],
    flag: &str,
    cwd: &Path,
) -> Option<String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    command.args(leading_args).arg(flag).current_dir(cwd);

    command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .and_then(|child| wait_child_output_with_timeout(child, CLI_VERSION_TIMEOUT).ok())
        .filter(|output| output.status.success())
        .map(|output| trim_output(&output.stdout))
        .filter(|value| !value.is_empty())
}

pub fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub fn codex_home_dir() -> Option<PathBuf> {
    user_home_dir().map(|home| home.join(".codex"))
}

pub fn codex_config_file() -> Option<PathBuf> {
    codex_home_dir().map(|home| home.join("config.toml"))
}

pub fn codex_models_cache_file() -> Option<PathBuf> {
    codex_home_dir().map(|home| home.join("models_cache.json"))
}

pub fn opencode_command_version(binary: &Path, cwd: &Path) -> Result<String, String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    apply_opencode_runtime_env(&mut command)?;
    let output = command
        .arg("--version")
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Failed to inspect OpenCode version: {error}"))?;

    if output.status.success() {
        let version = trim_output(&output.stdout);
        if !version.is_empty() {
            return Ok(version);
        }
    }

    let stderr = trim_output(&output.stderr);
    let stdout = trim_output(&output.stdout);
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "unknown error".to_string()
    };

    Err(format!("Failed to inspect OpenCode version: {detail}"))
}

#[cfg(target_os = "windows")]
pub fn opencode_windows_xdg_home(kind: &str) -> Option<PathBuf> {
    let base = std::env::var_os("DESIGNCODE_OPENCODE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("DesignCode").join("opencode"))
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("DesignCode").join("opencode"))
        })
        .or_else(|| user_home_dir().map(|home| home.join(".designcode").join("opencode")))?;

    Some(base.join("xdg").join(kind))
}

pub fn apply_opencode_runtime_env(command: &mut Command) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    let _ = command;

    #[cfg(target_os = "windows")]
    {
        let Some(config_home) = opencode_windows_xdg_home("config") else {
            return Ok(());
        };
        let Some(data_home) = opencode_windows_xdg_home("data") else {
            return Ok(());
        };
        let Some(cache_home) = opencode_windows_xdg_home("cache") else {
            return Ok(());
        };
        let Some(state_home) = opencode_windows_xdg_home("state") else {
            return Ok(());
        };

        for directory in [&config_home, &data_home, &cache_home, &state_home] {
            fs::create_dir_all(directory).map_err(|error| {
                format!(
                    "Failed to prepare OpenCode runtime directory {}: {error}",
                    directory.display()
                )
            })?;
        }

        command.env("XDG_CONFIG_HOME", &config_home);
        command.env("XDG_DATA_HOME", &data_home);
        command.env("XDG_CACHE_HOME", &cache_home);
        command.env("XDG_STATE_HOME", &state_home);
    }

    Ok(())
}

pub fn opencode_log_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(home) = user_home_dir() {
        candidates.push(home.join(".local").join("share").join("opencode").join("log"));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(data_home) = opencode_windows_xdg_home("data") {
            candidates.push(data_home.join("opencode").join("log"));
        }

        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local_app_data);
            candidates.push(base.join("OpenCode").join("log"));
            candidates.push(base.join("opencode").join("log"));
        }

        if let Some(app_data) = std::env::var_os("APPDATA") {
            let base = PathBuf::from(app_data);
            candidates.push(base.join("OpenCode").join("log"));
            candidates.push(base.join("opencode").join("log"));
        }
    }

    candidates
}

pub fn latest_opencode_log_file() -> Option<PathBuf> {
    let mut latest = None;

    for log_dir in opencode_log_dirs() {
        let Ok(entries) = fs::read_dir(log_dir) else {
            continue;
        };

        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let Some(modified) = entry.metadata().ok().and_then(|meta| meta.modified().ok()) else {
                continue;
            };

            match latest.as_ref() {
                Some((current_modified, _)) if *current_modified >= modified => {}
                _ => latest = Some((modified, path)),
            }
        }
    }

    latest.map(|(_, path)| path)
}

pub fn latest_opencode_log_line() -> Option<String> {
    let path = latest_opencode_log_file()?;
    fs::read_to_string(path)
        .ok()?
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

pub fn opencode_auth_diagnostic_from_log(provider_id: &str) -> OpencodeAuthDiagnostic {
    let Some(log_file) = latest_opencode_log_file() else {
        return OpencodeAuthDiagnostic {
            status: "idle".to_string(),
            message: Some("尚未发现 OpenCode OAuth 日志。".to_string()),
            detail: None,
            log_file: None,
        };
    };

    let content = match fs::read_to_string(&log_file) {
        Ok(content) => content,
        Err(error) => {
            return OpencodeAuthDiagnostic {
                status: "error".to_string(),
                message: Some(format!("读取 OpenCode 日志失败：{error}")),
                detail: None,
                log_file: Some(log_file.display().to_string()),
            };
        }
    };

    let lines: Vec<&str> = content.lines().collect();
    let authorize_marker = format!("path=/provider/{provider_id}/oauth/authorize");
    let last_authorize = lines
        .iter()
        .rposition(|line| line.contains(&authorize_marker) && line.contains("method=POST"));

    let Some(authorize_index) = last_authorize else {
        return OpencodeAuthDiagnostic {
            status: "idle".to_string(),
            message: Some("尚未发起浏览器授权。".to_string()),
            detail: None,
            log_file: Some(log_file.display().to_string()),
        };
    };

    let relevant = &lines[authorize_index..];
    let latest_line = relevant.last().copied().unwrap_or_default().to_string();

    if let Some(line) = relevant
        .iter()
        .rev()
        .find(|line| line.contains("OAuth callback timeout - authorization took too long"))
    {
        return OpencodeAuthDiagnostic {
            status: "error".to_string(),
            message: Some("OpenCode 在 5 分钟内没有收到浏览器回调。".to_string()),
            detail: Some(format!(
                "请确认浏览器最终跳转到了 localhost:1455/auth/callback，并且代理、浏览器扩展或隐私模式没有拦截本地回环地址。日志：{}",
                line.trim()
            )),
            log_file: Some(log_file.display().to_string()),
        };
    }

    if let Some(line) = relevant
        .iter()
        .rev()
        .find(|line| line.contains("Missing authorization code"))
    {
        return OpencodeAuthDiagnostic {
            status: "error".to_string(),
            message: Some("浏览器已回跳到本地回调，但没有带回授权 code。".to_string()),
            detail: Some(format!(
                "这通常表示授权页没有真正完成，或浏览器清理了回调参数。请重新从新的授权页完成登录。日志：{}",
                line.trim()
            )),
            log_file: Some(log_file.display().to_string()),
        };
    }

    if let Some(line) = relevant
        .iter()
        .rev()
        .find(|line| line.contains("Token exchange failed: 403 rejection"))
    {
        return OpencodeAuthDiagnostic {
            status: "error".to_string(),
            message: Some("浏览器已完成回调，但 OpenAI 在 token 交换阶段拒绝了这次授权。".to_string()),
            detail: Some(format!(
                "这通常不是 localhost 回调问题，而是运行时出口网络或账号授权被拒。请确认软件里的代理已经应用到 OpenCode 进程，并且浏览器与 OpenCode 走的是同一条代理链路。日志：{}",
                line.trim()
            )),
            log_file: Some(log_file.display().to_string()),
        };
    }

    if let Some(line) = relevant
        .iter()
        .rev()
        .find(|line| line.contains("Unable to connect. Is the computer able to access the url?"))
    {
        return OpencodeAuthDiagnostic {
            status: "error".to_string(),
            message: Some("OpenCode 无法访问 OpenAI 授权地址。".to_string()),
            detail: Some(format!(
                "请先检查代理连通性，再重新发起浏览器授权。日志：{}",
                line.trim()
            )),
            log_file: Some(log_file.display().to_string()),
        };
    }

    if relevant
        .iter()
        .any(|line| line.contains("service=plugin.codex") && line.contains("oauth server started"))
    {
        return OpencodeAuthDiagnostic {
            status: "waiting".to_string(),
            message: Some("OpenCode 已启动本地回调监听，正在等待浏览器跳回 localhost:1455。".to_string()),
            detail: Some(latest_line),
            log_file: Some(log_file.display().to_string()),
        };
    }

    OpencodeAuthDiagnostic {
        status: "idle".to_string(),
        message: Some("最近一次授权尚未进入等待回调状态。".to_string()),
        detail: Some(latest_line),
        log_file: Some(log_file.display().to_string()),
    }
}

#[cfg(unix)]
pub fn listening_process_ids(port: u16) -> Result<Vec<u32>, String> {
    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|error| format!("Failed to inspect listening processes on port {port}: {error}"))?;

    if !output.status.success() && !output.stdout.is_empty() {
        return Err(format!(
            "Failed to inspect listening processes on port {port}: {}",
            trim_output(&output.stderr)
        ));
    }

    Ok(trim_output(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect())
}

#[cfg(target_os = "windows")]
pub fn listening_process_ids(port: u16) -> Result<Vec<u32>, String> {
    let mut command = Command::new("netstat");
    configure_background_command(&mut command);
    let output = command
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| format!("Failed to inspect listening processes on port {port}: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to inspect listening processes on port {port}: {}",
            trim_output(&output.stderr)
        ));
    }

    let port_suffix = format!(":{port}");
    let mut pids = BTreeSet::new();

    for line in trim_output(&output.stdout).lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 5 {
            continue;
        }

        let local = columns[1];
        let foreign = columns[2];
        let pid = columns[4];

        if !local.ends_with(&port_suffix) {
            continue;
        }

        if foreign != "0.0.0.0:0" && foreign != "[::]:0" && foreign != "*:*" {
            continue;
        }

        if let Ok(pid) = pid.parse::<u32>() {
            pids.insert(pid);
        }
    }

    Ok(pids.into_iter().collect())
}

#[cfg(unix)]
pub fn process_command_line(pid: u32) -> Option<String> {
    Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| trim_output(&output.stdout))
        .filter(|output| !output.is_empty())
}

#[cfg(target_os = "windows")]
pub fn process_command_line(pid: u32) -> Option<String> {
    let script = format!("(Get-Process -Id {pid} -ErrorAction Stop).ProcessName");
    let mut command = Command::new("powershell.exe");
    configure_background_command(&mut command);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| trim_output(&output.stdout))
        .filter(|output| !output.is_empty())
}

#[cfg(unix)]
pub fn kill_pid(pid: u32, signal: &str) -> Result<(), String> {
    let status = Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()
        .map_err(|error| format!("Failed to send {signal} to pid {pid}: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to send {signal} to pid {pid}."))
    }
}

#[cfg(target_os = "windows")]
pub fn kill_pid(pid: u32, _signal: &str) -> Result<(), String> {
    let script = format!("Stop-Process -Id {pid} -Force -ErrorAction Stop");
    let mut command = Command::new("powershell.exe");
    configure_background_command(&mut command);
    let output = command
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .output()
        .map_err(|error| format!("Failed to terminate pid {pid}: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to terminate pid {pid}: {}",
            trim_output(&output.stderr)
        ))
    }
}

#[cfg(any(unix, target_os = "windows"))]
pub fn kill_opencode_listeners(ports: &[u16]) -> Result<Vec<u32>, String> {
    let mut candidate_pids = BTreeSet::new();
    for port in ports {
        for pid in listening_process_ids(*port)? {
            candidate_pids.insert(pid);
        }
    }

    let mut killed = Vec::new();
    for pid in candidate_pids {
        let Some(command) = process_command_line(pid) else {
            continue;
        };

        if !command.contains("opencode") {
            continue;
        }

        // opencode 进程树里还挂着 node 子进程（MCP servers、shell 工具等），
        // 先递归清理子孙再杀主进程，避免 grandchildren 被 launchd 收养成残留
        crate::gemini::kill_child_descendants(pid);
        let _ = kill_pid(pid, "-TERM");
        killed.push(pid);
    }

    if !killed.is_empty() {
        // 给 SIGTERM 一点时间让 opencode flush；然后 SIGKILL 兜底，避免
        // 某些子进程忽略 TERM 把端口继续占着
        std::thread::sleep(Duration::from_millis(150));
        for pid in &killed {
            let _ = kill_pid(*pid, "-KILL");
        }
    }

    Ok(killed)
}

#[cfg(not(any(unix, target_os = "windows")))]
pub fn kill_opencode_listeners(_ports: &[u16]) -> Result<Vec<u32>, String> {
    Ok(Vec::new())
}

pub fn runtime_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

pub fn runtime_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

pub fn runtime_key() -> String {
    format!("{}-{}", runtime_platform(), runtime_arch())
}

pub fn runtime_binary_name(base_name: &str) -> String {
    if cfg!(windows) {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    }
}

pub fn bundled_runtime_relative_path(kind: &str) -> PathBuf {
    PathBuf::from("runtime")
        .join(runtime_key())
        .join(kind)
        .join(runtime_binary_name(kind))
}

pub fn bundled_runtime_relative_support_path(kind: &str, relative: &str) -> PathBuf {
    PathBuf::from("runtime")
        .join(runtime_key())
        .join(kind)
        .join(relative)
}

pub fn bundled_runtime_source_candidates(app: &AppHandle, relative: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(relative));
        candidates.push(resource_dir.join("resources").join(relative));
    }

    if let Ok(root) = resolve_project_root(app) {
        candidates.push(root.join("src-tauri").join("resources").join(relative));
    }

    candidates
}

pub fn bundled_runtime_source_path(app: &AppHandle, relative: &Path) -> Option<PathBuf> {
    bundled_runtime_source_candidates(app, relative)
        .into_iter()
        .find(|candidate| candidate.exists())
}

#[cfg(target_os = "windows")]
pub fn is_explicit_binary_path(candidate: &Path) -> bool {
    candidate.is_absolute()
        || candidate
            .parent()
            .map(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(false)
}

pub fn normalize_requested_binary_path(candidate: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if !is_explicit_binary_path(&candidate) {
            return candidate;
        }

        let extension = candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());

        let mut alternatives = Vec::new();
        match extension.as_deref() {
            Some("exe") => return candidate,
            Some("ps1") => {
                alternatives.push(candidate.with_extension("exe"));
                alternatives.push(candidate.with_extension("cmd"));
                alternatives.push(candidate.with_extension("bat"));
            }
            Some("cmd") | Some("bat") => {
                alternatives.push(candidate.with_extension("exe"));
            }
            None => {
                alternatives.push(candidate.with_extension("exe"));
                alternatives.push(candidate.with_extension("cmd"));
                alternatives.push(candidate.with_extension("bat"));
                alternatives.push(candidate.with_extension("ps1"));
            }
            _ => {}
        }

        for alternative in alternatives {
            if alternative.exists() {
                return alternative;
            }
        }
    }

    candidate
}

pub fn stage_bundled_runtime_binary(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    let relative = bundled_runtime_relative_path(kind);
    let source = bundled_runtime_source_candidates(app, &relative)
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("Bundled {kind} runtime is missing."))?;

    // Windows 上不存在 macOS 的代码签名 inode 缓存问题，直接使用安装目录内的运行时
    if cfg!(windows) {
        return Ok(source);
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let destination = data_dir.join(&relative);

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create runtime directory: {error}"))?;
    }

    let should_copy = match (fs::metadata(&source), fs::metadata(&destination)) {
        (Ok(source_meta), Ok(destination_meta)) => {
            source_meta.len() != destination_meta.len()
                || source_meta
                    .modified()
                    .ok()
                    .zip(destination_meta.modified().ok())
                    .map(|(source_time, destination_time)| source_time > destination_time)
                    .unwrap_or(false)
        }
        (Ok(_), Err(_)) => true,
        _ => true,
    };

    if should_copy {
        // 先删除旧文件再复制，确保生成新的 inode。
        // macOS 对同一 inode 的 code-signing 评估结果有缓存，
        // 原地覆写不会刷新缓存，可能导致 SIGKILL。
        let _ = fs::remove_file(&destination);
        fs::copy(&source, &destination)
            .map_err(|error| format!("Failed to stage bundled {kind} runtime: {error}"))?;
    }

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&destination)
            .map_err(|error| format!("Failed to inspect staged {kind} runtime: {error}"))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&destination, permissions)
            .map_err(|error| format!("Failed to update staged {kind} permissions: {error}"))?;
    }

    Ok(destination)
}

pub fn resolve_node_binary(app: &AppHandle) -> PathBuf {
    stage_bundled_runtime_binary(app, "node")
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_NODE_BINARY))
}

pub fn resolve_opencode_binary(app: &AppHandle, requested: Option<&str>) -> PathBuf {
    let desired = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_OPENCODE_BINARY);

    if desired == DEFAULT_OPENCODE_BINARY {
        return stage_bundled_runtime_binary(app, "opencode")
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_OPENCODE_BINARY));
    }

    normalize_requested_binary_path(PathBuf::from(desired))
}

pub fn resolve_codex_binary(app: &AppHandle, requested: Option<&str>) -> PathBuf {
    let desired = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CODEX_BINARY);

    if desired == DEFAULT_CODEX_BINARY {
        return stage_bundled_runtime_binary(app, "codex")
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_CODEX_BINARY));
    }

    normalize_requested_binary_path(PathBuf::from(desired))
}

pub fn resolve_claude_binary(app: &AppHandle, requested: Option<&str>) -> PathBuf {
    let desired = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CLAUDE_BINARY);

    if desired == DEFAULT_CLAUDE_BINARY {
        return stage_bundled_runtime_binary(app, "claude")
            .unwrap_or_else(|_| PathBuf::from(DEFAULT_CLAUDE_BINARY));
    }

    normalize_requested_binary_path(PathBuf::from(desired))
}

pub fn resolve_gemini_launch(app: &AppHandle, requested: Option<&str>) -> CliLaunch {
    let desired = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_GEMINI_BINARY);

    if desired != DEFAULT_GEMINI_BINARY {
        let program = normalize_requested_binary_path(PathBuf::from(desired));
        return CliLaunch {
            display: program.display().to_string(),
            program,
            args: Vec::new(),
        };
    }

    let bundled_entry = bundled_runtime_relative_support_path("gemini", "package/dist/index.js");
    if let Some(entry) = bundled_runtime_source_path(app, &bundled_entry) {
        let node_binary = resolve_node_binary(app);
        return CliLaunch {
            display: format!("{} {}", node_binary.display(), entry.display()),
            program: node_binary,
            args: vec![entry.display().to_string()],
        };
    }

    if let Ok(binary) = stage_bundled_runtime_binary(app, "gemini") {
        return CliLaunch {
            display: binary.display().to_string(),
            program: binary,
            args: Vec::new(),
        };
    }

    CliLaunch {
        display: DEFAULT_GEMINI_BINARY.to_string(),
        program: PathBuf::from(DEFAULT_GEMINI_BINARY),
        args: Vec::new(),
    }
}

pub fn resolve_gemini_acp_sdk_path(app: &AppHandle) -> Result<PathBuf, String> {
    let sdk_relative = bundled_runtime_relative_support_path(
        "gemini",
        "package/node_modules/@agentclientprotocol/sdk/dist/acp.js",
    );

    bundled_runtime_source_path(app, &sdk_relative).ok_or_else(|| {
        "Unable to locate the bundled Gemini ACP SDK.".to_string()
    })
}

pub fn resolve_project_root(app: &AppHandle) -> Result<PathBuf, String> {
    fn push_with_ancestors(candidates: &mut Vec<PathBuf>, path: PathBuf) {
        let mut current = Some(path);
        while let Some(candidate) = current {
            if !candidates.iter().any(|existing| existing == &candidate) {
                candidates.push(candidate.clone());
            }
            current = candidate.parent().map(Path::to_path_buf);
        }
    }

    fn is_valid_project_root(candidate: &Path) -> bool {
        candidate.join("package.json").exists()
            && candidate.join("app/server/bridge-cli.js").exists()
    }

    fn candidate_rank(candidate: &Path) -> u8 {
        let in_target = candidate
            .components()
            .any(|component| component.as_os_str() == "target");
        if in_target { 1 } else { 0 }
    }

    let mut candidates = Vec::new();

    if let Ok(current) = std::env::current_dir() {
        push_with_ancestors(&mut candidates, current);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_with_ancestors(&mut candidates, resource_dir.clone());
        push_with_ancestors(&mut candidates, resource_dir.join("_up_"));
    }

    candidates
        .into_iter()
        .filter(|candidate| is_valid_project_root(candidate))
        .min_by_key(|candidate| (candidate_rank(candidate), candidate.components().count()))
        .ok_or_else(|| "Unable to resolve DesignCode project root.".to_string())
}

pub fn bridge_data_root(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        return app.path().app_local_data_dir().ok();
    }

    None
}

pub fn run_node_bridge(app: &AppHandle, mode: &str, payload: Option<Value>) -> Result<Value, String> {
    let root = resolve_project_root(app)?;
    let script = root.join("app/server/bridge-cli.js");
    let node_binary = resolve_node_binary(app);

    let mut command = Command::new(&node_binary);
    // 缺了这个 Windows 下每次 Tauri→node 调用（菜单、设计列表、art-asset 等）
    // 都会蹦一个黑色控制台窗口一闪
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg(&script)
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(data_root) = bridge_data_root(app) {
        command.env("DESIGNCODE_STUDIO_ROOT", data_root);
    }

    let mut child = command
        .spawn()
        .map_err(|error| {
            format!(
                "Failed to start node bridge with {}: {error}",
                node_binary.display()
            )
        })?;

    if let Some(body) = payload {
        if let Some(stdin) = child.stdin.as_mut() {
            stdin
                .write_all(body.to_string().as_bytes())
                .map_err(|error| format!("Failed to write payload to node bridge: {error}"))?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Failed to read node bridge output: {error}"))?;

    if !output.status.success() {
        let stderr = trim_output(&output.stderr);
        let stdout = trim_output(&output.stdout);
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to decode node bridge response: {error}"))
}

pub fn strip_cli_warning_lines(text: &str) -> String {
    text.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("WARNING:")
                && trimmed != "Loaded cached credentials."
                && !trimmed.contains("[STARTUP] Phase 'cli_startup' was started but never ended.")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub fn sanitize_gemini_stderr_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed == "Loaded cached credentials."
        || trimmed.contains("[STARTUP] Phase 'cli_startup' was started but never ended.")
        || trimmed.starts_with("Attempt ")
        || trimmed.starts_with("GaxiosError:")
        || trimmed.starts_with("at ")
        || trimmed.starts_with("{")
        || trimmed.starts_with("}")
        || trimmed.starts_with("[")
        || trimmed.starts_with("]")
        || trimmed.starts_with("'")
        || trimmed.starts_with("\"")
        || trimmed.starts_with("[Symbol")
        || trimmed == "},"
        || trimmed == "],"
        || trimmed == "}, {"
    {
        return None;
    }

    if trimmed.contains("MODEL_CAPACITY_EXHAUSTED")
        || trimmed.contains("RESOURCE_EXHAUSTED")
        || trimmed.contains("rateLimitExceeded")
        || trimmed.contains("No capacity available for model")
    {
        return None;
    }

    if [
        "config:",
        "response:",
        "headers:",
        "request:",
        "data:",
        "proxy:",
        "url:",
        "method:",
        "params:",
        "body:",
        "signal:",
        "retry:",
        "paramsSerializer:",
        "validateStatus:",
        "agent:",
        "errorRedactor:",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix))
    {
        return None;
    }

    Some(trimmed.to_string())
}

pub fn merge_no_proxy() -> String {
    let existing_no_proxy = std::env::var("NO_PROXY").unwrap_or_default();
    let base_no_proxy = "127.0.0.1,localhost";
    if existing_no_proxy.trim().is_empty() {
        base_no_proxy.to_string()
    } else if existing_no_proxy.contains("127.0.0.1") || existing_no_proxy.contains("localhost") {
        existing_no_proxy
    } else {
        format!("{base_no_proxy},{}", existing_no_proxy)
    }
}

pub fn resolve_proxy_value(proxy: Option<&str>) -> Option<String> {
    proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn replace_proxy_scheme(proxy_url: &str, scheme: &str) -> String {
    if let Some((_current_scheme, rest)) = proxy_url.split_once("://") {
        format!("{scheme}://{rest}")
    } else {
        format!("{scheme}://{proxy_url}")
    }
}

pub fn resolve_proxy_urls(proxy: Option<&str>) -> Option<(String, String)> {
    let proxy_url = resolve_proxy_value(proxy)?;
    let lower = proxy_url.to_ascii_lowercase();

    let (http_proxy_url, socks_proxy_url) = if lower.starts_with("socks5://")
        || lower.starts_with("socks5h://")
        || lower.starts_with("socks://")
    {
        (replace_proxy_scheme(&proxy_url, "http"), replace_proxy_scheme(&proxy_url, "socks5"))
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        (proxy_url.clone(), replace_proxy_scheme(&proxy_url, "socks5"))
    } else {
        (
            format!("http://{proxy_url}"),
            format!("socks5://{proxy_url}"),
        )
    };

    Some((http_proxy_url, socks_proxy_url))
}

pub fn clear_proxy_env(command: &mut Command) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        command.env_remove(key);
    }
}

pub fn apply_proxy_env(command: &mut Command, proxy: Option<&str>) {
    clear_proxy_env(command);
    if let Some((http_proxy_url, socks_proxy_url)) = resolve_proxy_urls(proxy) {
        let no_proxy = merge_no_proxy();
        command.env("HTTP_PROXY", &http_proxy_url);
        command.env("HTTPS_PROXY", &http_proxy_url);
        command.env("ALL_PROXY", &socks_proxy_url);
        command.env("http_proxy", &http_proxy_url);
        command.env("https_proxy", &http_proxy_url);
        command.env("all_proxy", &socks_proxy_url);
        command.env("NO_PROXY", &no_proxy);
        command.env("no_proxy", &no_proxy);
    }
}

pub fn clear_gemini_auth_env(command: &mut Command) {
    for key in [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GOOGLE_CLOUD_PROJECT_ID",
        "GOOGLE_CLOUD_LOCATION",
        "GOOGLE_GENAI_USE_VERTEXAI",
        "GOOGLE_GENAI_USE_GCA",
        "CLOUD_SHELL",
        "GEMINI_CLI_USE_COMPUTE_ADC",
    ] {
        command.env_remove(key);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(target_os = "windows")]
pub fn terminal_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(not(target_os = "windows"))]
pub fn terminal_quote(value: &str) -> String {
    shell_single_quote(value)
}

#[cfg(target_os = "windows")]
pub fn terminal_env_assignment(key: &str, value: &str) -> String {
    format!(
        "set \"{key}={}\"",
        value.replace('%', "%%").replace('"', "\"\"")
    )
}

pub fn shell_command_text(binary: &Path, leading_args: &[String], trailing_args: &[String]) -> String {
    let mut parts = Vec::with_capacity(2 + leading_args.len() + trailing_args.len());

    #[cfg(target_os = "windows")]
    {
        let needs_call = binary
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("cmd") || value.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if needs_call {
            parts.push("call".to_string());
        }
    }

    parts.push(terminal_quote(&binary.display().to_string()));
    parts.extend(leading_args.iter().map(|value| terminal_quote(value)));
    parts.extend(trailing_args.iter().map(|value| terminal_quote(value)));
    parts.join(" ")
}

pub fn emit_cli_stream_line(
    app: &AppHandle,
    backend: &str,
    stream_id: &str,
    channel: &str,
    line: &str,
) {
    let _ = app.emit(
        CLI_STREAM_EVENT,
        CliStreamEvent {
            stream_id: stream_id.to_string(),
            backend: backend.to_string(),
            channel: channel.to_string(),
            line: line.to_string(),
            // 多 tab 路由：当前 emit 链路尚未带上 run_id；前端按 stream_id 兜底分发。
            // 后续可以让各 backend 模块在创建 stream 时把 run_id 注册到一个映射，
            // 这里再查映射回填 run_id。先发空字符串维持兼容。
            run_id: String::new(),
        },
    );
}

pub fn emit_cli_stream_json_event(app: &AppHandle, backend: &str, stream_id: &str, value: &Value) {
    if let Ok(line) = serde_json::to_string(value) {
        emit_cli_stream_line(app, backend, stream_id, "stdout", &line);
    }
}

pub fn json_rpc_id_string(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(number) = value.as_i64() {
        return Some(number.to_string());
    }
    if let Some(number) = value.as_u64() {
        return Some(number.to_string());
    }
    None
}

// ---------------------------------------------------------------------------
// 散布的工具函数
// ---------------------------------------------------------------------------

pub fn read_json_string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }

    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub fn proxy_env_prefix(proxy: Option<&str>) -> String {
    #[cfg(target_os = "windows")]
    {
        return resolve_proxy_value(proxy)
            .map(|proxy_url| {
                let no_proxy = merge_no_proxy();
                [
                    terminal_env_assignment("HTTP_PROXY", &proxy_url),
                    terminal_env_assignment("HTTPS_PROXY", &proxy_url),
                    terminal_env_assignment("ALL_PROXY", &proxy_url),
                    terminal_env_assignment("http_proxy", &proxy_url),
                    terminal_env_assignment("https_proxy", &proxy_url),
                    terminal_env_assignment("all_proxy", &proxy_url),
                    terminal_env_assignment("NO_PROXY", &no_proxy),
                    terminal_env_assignment("no_proxy", &no_proxy),
                ]
                .join(" && ")
                    + " && "
            })
            .unwrap_or_default();
    }

    #[cfg(not(target_os = "windows"))]
    resolve_proxy_urls(proxy)
        .map(|(http_proxy_url, socks_proxy_url)| {
            let no_proxy = merge_no_proxy();
            format!(
                "HTTP_PROXY={} HTTPS_PROXY={} ALL_PROXY={} http_proxy={} https_proxy={} all_proxy={} NO_PROXY={} no_proxy={} ",
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&socks_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&http_proxy_url),
                shell_single_quote(&socks_proxy_url),
                shell_single_quote(&no_proxy),
                shell_single_quote(&no_proxy)
            )
        })
        .unwrap_or_default()
}

pub fn wait_child_output_with_timeout(mut child: Child, timeout: Duration) -> Result<Output, String> {
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();

    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stdout.read_to_end(&mut buffer);
            let _ = stdout_tx.send(buffer);
        });
    } else {
        let _ = stdout_tx.send(Vec::new());
    }

    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stderr.read_to_end(&mut buffer);
            let _ = stderr_tx.send(buffer);
        });
    } else {
        let _ = stderr_tx.send(Vec::new());
    }

    let started_at = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = stdout_rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
                let stderr = stderr_rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
                return Ok(Output { status, stdout, stderr });
            }
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let stderr = stderr_rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
                    let detail = trim_output(&stderr);
                    return Err(if detail.is_empty() {
                        format!("Codex request timed out after {}s.", timeout.as_secs())
                    } else {
                        format!(
                            "Codex request timed out after {}s. {detail}",
                            timeout.as_secs()
                        )
                    });
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(format!("Failed to poll Codex process: {error}")),
        }
    }
}

pub fn read_nested_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(ToOwned::to_owned)
}

pub fn read_package_version(package_root: &Path) -> Option<String> {
    let manifest = fs::read_to_string(package_root.join("package.json")).ok()?;
    serde_json::from_str::<Value>(&manifest)
        .ok()
        .and_then(|value| read_json_string_at(&value, &["version"]))
}

pub fn open_terminal_command(command_text: &str, success_message: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "tell application \"Terminal\" to do script {}",
                serde_json::to_string(command_text)
                    .map_err(|error| format!("Failed to encode terminal command: {error}"))?
            ))
            .arg("-e")
            .arg("tell application \"Terminal\" to activate")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;

        return Ok(success_message.to_string());
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut command = Command::new("cmd.exe");
        command.creation_flags(CREATE_NEW_CONSOLE);
        command
            .args(["/D", "/K", command_text])
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;
        return Ok(success_message.to_string());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("x-terminal-emulator")
            .arg("-e")
            .arg(command_text)
            .spawn()
            .map_err(|error| format!("Failed to open terminal: {error}"))?;
        return Ok(success_message.to_string());
    }
}
