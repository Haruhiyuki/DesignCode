// Claude Code stream 子系统。
// 通过 --input-format stream-json 与 claude 进程持续交互，
// 管理会话复用、消息收发、登录检测、模型目录。

use crate::types::*;
use crate::utils::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// 登录/状态
// ---------------------------------------------------------------------------

pub fn claude_login_status(binary: &Path, cwd: &Path) -> Result<(bool, String, Option<String>), String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    let output = command
        .args(["auth", "status"])
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("Failed to inspect Claude Code auth status: {error}"))?;

    let stdout = strip_cli_warning_lines(&trim_output(&output.stdout));
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));
    let text = if !stdout.is_empty() { stdout } else { stderr };

    if text.is_empty() {
        return Ok((false, "\u{672a}\u{68c0}\u{6d4b}\u{5230} Claude Code \u{767b}\u{5f55}\u{72b6}\u{6001}\u{3002}".to_string(), None));
    }

    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        let logged_in = value.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
        let auth_method = value
            .get("authMethod")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|value| !value.is_empty() && value != "none");
        let provider = value
            .get("apiProvider")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|value| !value.is_empty());
        let status = if logged_in {
            match (auth_method.as_deref(), provider.as_deref()) {
                (Some(method), Some(api_provider)) => format!("Logged in via {method} \u{00b7} {api_provider}"),
                (Some(method), None) => format!("Logged in via {method}"),
                _ => "Logged in".to_string(),
            }
        } else {
            "\u{672a}\u{767b}\u{5f55} Claude Code\u{3002}".to_string()
        };

        return Ok((logged_in, status, auth_method));
    }

    Ok((output.status.success(), text, None))
}

pub fn claude_status_snapshot(app: &AppHandle, requested_binary: Option<&str>) -> Result<CliRuntimeStatus, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let version = command_version(&binary, "--version", &root);
    let installed = version.is_some();
    let (logged_in, login_status, auth_method) = if installed {
        claude_login_status(&binary, &root)?
    } else {
        (false, "\u{672a}\u{68c0}\u{6d4b}\u{5230} Claude Code CLI\u{3002}".to_string(), None)
    };

    Ok(CliRuntimeStatus {
        installed,
        version,
        binary: binary.display().to_string(),
        logged_in,
        login_status,
        auth_method,
        default_model: read_claude_default_model(),
        default_effort: read_claude_default_effort(),
    })
}

// ---------------------------------------------------------------------------
// 配置/模型
// ---------------------------------------------------------------------------

pub fn claude_config_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| user_home_dir().map(|home| home.join(".claude")))
}

pub fn read_claude_settings() -> Option<Value> {
    let path = claude_config_dir()?.join("settings.json");
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn read_claude_default_model() -> Option<String> {
    read_claude_settings()
        .and_then(|settings| settings.get("model").and_then(Value::as_str).map(str::trim).map(ToOwned::to_owned))
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("ANTHROPIC_MODEL").ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty()))
}

pub fn read_claude_default_effort() -> Option<String> {
    read_claude_settings()
        .and_then(|settings| settings.get("effortLevel").and_then(Value::as_str).map(str::trim).map(ToOwned::to_owned))
        .and_then(|value| normalize_claude_effort(&value))
}

pub fn normalize_claude_effort(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "" | "default" | "auto" => None,
        "low" | "medium" | "high" | "max" => Some(normalized),
        _ => None,
    }
}

pub fn read_claude_help_text(binary: &Path, cwd: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    let child = command
        .current_dir(cwd)
        .arg("--help")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let output = wait_child_output_with_timeout(child, CLI_VERSION_TIMEOUT).ok()?;
    let stdout = trim_output(&output.stdout);
    if !stdout.is_empty() {
        return Some(stdout);
    }
    let stderr = trim_output(&output.stderr);
    if stderr.is_empty() {
        None
    } else {
        Some(stderr)
    }
}

pub fn parse_claude_effort_levels(help_text: &str) -> Vec<String> {
    let mut levels = Vec::new();
    for line in help_text.lines() {
        if !line.contains("--effort") {
            continue;
        }
        if let (Some(start), Some(end)) = (line.rfind('('), line.rfind(')')) {
            let choices = &line[start + 1..end];
            for value in choices.split(',') {
                if let Some(level) = normalize_claude_effort(value) {
                    if !levels.iter().any(|entry| entry == &level) {
                        levels.push(level);
                    }
                }
            }
        }
    }
    if levels.is_empty() {
        levels = vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "max".to_string(),
        ];
    }
    levels
}

pub fn build_claude_model_catalog(app: &AppHandle, requested_binary: Option<&str>) -> Result<ClaudeModelsResult, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let help_text = read_claude_help_text(&binary, &root).unwrap_or_default();
    let mut model_ids = BTreeSet::from([
        "sonnet".to_string(),
        "opus".to_string(),
        "haiku".to_string(),
        "sonnet[1m]".to_string(),
        "opusplan".to_string(),
    ]);

    let settings = read_claude_settings();
    if let Some(model) = settings
        .as_ref()
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        model_ids.insert(model.to_string());
    }
    if let Some(overrides) = settings.as_ref().and_then(|value| value.get("modelOverrides")).and_then(Value::as_object) {
        for (key, value) in overrides {
            let key = key.trim();
            if !key.is_empty() {
                model_ids.insert(key.to_string());
            }
            if let Some(value) = value.as_str().map(str::trim).filter(|entry| !entry.is_empty()) {
                model_ids.insert(value.to_string());
            }
        }
    }
    if let Ok(model) = std::env::var("ANTHROPIC_MODEL") {
        let model = model.trim();
        if !model.is_empty() {
            model_ids.insert(model.to_string());
        }
    }
    for key in [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Ok(model) = std::env::var(key) {
            let model = model.trim();
            if !model.is_empty() {
                model_ids.insert(model.to_string());
            }
        }
    }

    let preferred_order = ["sonnet", "opus", "opusplan", "haiku", "sonnet[1m]"];
    let mut available_models = model_ids
        .into_iter()
        .map(|id| ClaudeModel {
            name: id.clone(),
            id,
            description: None,
        })
        .collect::<Vec<_>>();
    available_models.sort_by_key(|model| {
        (
            preferred_order
                .iter()
                .position(|entry| entry == &model.id.as_str())
                .unwrap_or(preferred_order.len()),
            model.id.clone(),
        )
    });

    Ok(ClaudeModelsResult {
        available_models,
        available_efforts: parse_claude_effort_levels(&help_text),
        current_model_id: read_claude_default_model(),
        current_effort: read_claude_default_effort(),
    })
}

// ---------------------------------------------------------------------------
// 登录终端
// ---------------------------------------------------------------------------

pub fn open_claude_login_terminal(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let binary = resolve_claude_binary(app, requested_binary);
    let command_text = format!(
        "{}{}",
        proxy_env_prefix(proxy),
        shell_command_text(&binary, &[], &["auth".to_string(), "login".to_string()])
    );
    open_terminal_command(
        &command_text,
        "\u{5df2}\u{5728}\u{7cfb}\u{7edf}\u{7ec8}\u{7aef}\u{4e2d}\u{6253}\u{5f00} `claude auth login`\u{3002}\u{5b8c}\u{6210}\u{767b}\u{5f55}\u{540e}\u{56de}\u{5230}\u{8f6f}\u{4ef6}\u{70b9}\u{201c}\u{5237}\u{65b0}\u{72b6}\u{6001}\u{201d}\u{6216}\u{201c}\u{9a8c}\u{8bc1}\u{8fde}\u{63a5}\u{201d}\u{3002}",
    )
}

// ---------------------------------------------------------------------------
// Stream 事件解析
// ---------------------------------------------------------------------------

pub fn extract_cli_session_id(event: &Value) -> Option<String> {
    event.get("session_id")
        .and_then(Value::as_str)
        .or_else(|| event.get("sessionId").and_then(Value::as_str))
        .or_else(|| event.get("thread_id").and_then(Value::as_str))
        .or_else(|| event.get("threadId").and_then(Value::as_str))
        .or_else(|| event.get("conversation_id").and_then(Value::as_str))
        .or_else(|| event.get("conversationId").and_then(Value::as_str))
        .or_else(|| event.get("checkpoint_id").and_then(Value::as_str))
        .or_else(|| event.get("checkpointId").and_then(Value::as_str))
        .or_else(|| event.get("session").and_then(|value| value.get("id")).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

pub fn extract_claude_last_message(events: &[Value]) -> String {
    for event in events.iter().rev() {
        if event.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(text) = event.get("result").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
                return text.to_string();
            }
        }

        if event.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(content) = event
                .get("message")
                .and_then(|value| value.get("content"))
                .and_then(Value::as_array)
            {
                let text = content
                    .iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    return text;
                }
            }
        }
    }

    String::new()
}

pub fn extract_claude_event_message(event: &Value) -> Option<String> {
    if let Some(text) = event
        .get("result")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(content) = event
        .get("message")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
    {
        let text = content
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

pub fn claude_stream_error_message(event: &Value) -> Option<String> {
    if event
        .get("type")
        .and_then(Value::as_str)
        == Some("result")
        && event.get("is_error").and_then(Value::as_bool).unwrap_or(false)
    {
        if let Some(result) = event.get("result").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()) {
            return Some(result.to_string());
        }
    }

    event.get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

// ---------------------------------------------------------------------------
// Stream 客户端辅助
// ---------------------------------------------------------------------------

pub fn set_claude_client_fatal_error(client: &ClaudeStreamClient, message: String) {
    if let Ok(mut fatal_error) = client.fatal_error.lock() {
        *fatal_error = Some(message);
    }
}

pub fn take_claude_pending_turn(
    pending_turn: &Arc<Mutex<Option<ClaudePendingTurn>>>,
) -> Option<ClaudePendingTurn> {
    pending_turn
        .lock()
        .ok()
        .and_then(|mut turn| turn.take())
}

pub fn current_claude_stream_id(client: &ClaudeStreamClient) -> Option<String> {
    client
        .pending_turn
        .lock()
        .ok()
        .and_then(|turn| turn.as_ref().and_then(|turn| turn.stream_id.clone()))
}

// ---------------------------------------------------------------------------
// Stream 客户端生命周期
// ---------------------------------------------------------------------------

pub fn spawn_claude_stream_client(
    app: &AppHandle,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<ClaudeStreamClient>, String> {
    let binary = resolve_claude_binary(app, requested_binary);
    let binary_display = binary.display().to_string();
    let model_text = model.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let effort_text = effort.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let proxy_text = proxy.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let resume_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    command
        .current_dir(directory)
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--include-partial-messages")
        .arg("--permission-mode")
        .arg("acceptEdits");

    if let Some(existing_session) = resume_session.as_deref() {
        command.arg("--resume").arg(existing_session);
    }
    if let Some(model) = model_text.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort_text.as_deref() {
        command.arg("--effort").arg(effort);
    }

    apply_proxy_env(&mut command, proxy_text.as_deref());

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Claude Code stream session: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude Code stream stdin is not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude Code stream stdout is not available.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Claude Code stream stderr is not available.".to_string())?;
    let pid = child.id();

    let client = Arc::new(ClaudeStreamClient {
        stdin: Mutex::new(stdin),
        pid,
        session_id: Arc::new(Mutex::new(resume_session.clone())),
        last_message: Arc::new(Mutex::new(String::new())),
        fatal_error: Arc::new(Mutex::new(None)),
        pending_turn: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        exit_detail: Arc::new(Mutex::new(None)),
        directory: directory.to_string(),
        binary: binary_display,
        proxy: proxy_text,
        model: model_text,
        effort: effort_text,
        resume_session,
    });

    {
        let app = app.clone();
        let client = client.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let stream_id = current_claude_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(&app, "claude", stream_id, "stdout", &line);
                }

                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };

                if let Some(next_session_id) = extract_cli_session_id(&event) {
                    if let Ok(mut session) = client.session_id.lock() {
                        *session = Some(next_session_id);
                    }
                }

                if let Some(message) = extract_claude_event_message(&event) {
                    if let Ok(mut last_message) = client.last_message.lock() {
                        *last_message = message;
                    }
                }

                if let Some(error_message) = claude_stream_error_message(&event) {
                    set_claude_client_fatal_error(&client, error_message);
                }

                if event.get("type").and_then(Value::as_str) == Some("result") {
                    if let Some(turn) = take_claude_pending_turn(&client.pending_turn) {
                        let session_id = client
                            .session_id
                            .lock()
                            .ok()
                            .and_then(|value| value.clone());
                        let error = client
                            .fatal_error
                            .lock()
                            .ok()
                            .and_then(|value| value.clone());
                        let output = client
                            .last_message
                            .lock()
                            .map(|value| value.clone())
                            .unwrap_or_default();

                        let _ = turn.waiter.send(if let Some(error) = error {
                            Err(error)
                        } else {
                            Ok((session_id, output))
                        });
                    }
                }
            }
        });
    }

    {
        let app = app.clone();
        let client = client.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let stream_id = current_claude_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(&app, "claude", stream_id, "stderr", trimmed);
                }
            }
        });
    }

    {
        let client = client.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            client.exited.store(true, Ordering::SeqCst);
            let detail = match status {
                Ok(status) if status.success() => None,
                Ok(status) => Some(format!("Claude Code \u{4f1a}\u{8bdd}\u{5df2}\u{7ed3}\u{675f}\u{ff08}exit code: {}\u{ff09}\u{3002}", status)),
                Err(error) => Some(format!("Claude Code \u{4f1a}\u{8bdd}\u{5f02}\u{5e38}\u{9000}\u{51fa}\u{ff1a}{error}")),
            };

            if let Some(message) = detail.clone() {
                if let Ok(mut exit_detail) = client.exit_detail.lock() {
                    *exit_detail = Some(message.clone());
                }
                set_claude_client_fatal_error(&client, message.clone());
            }

            if let Some(turn) = take_claude_pending_turn(&client.pending_turn) {
                let error = client
                    .fatal_error
                    .lock()
                    .ok()
                    .and_then(|value| value.clone())
                    .or_else(|| detail.clone())
                    .unwrap_or_else(|| "Claude Code \u{4f1a}\u{8bdd}\u{5df2}\u{610f}\u{5916}\u{7ed3}\u{675f}\u{3002}".to_string());
                let _ = turn.waiter.send(Err(error));
            }
        });
    }

    Ok(client)
}

pub fn kill_claude_stream_client(client: &ClaudeStreamClient) {
    if client.exited.load(Ordering::SeqCst) {
        return;
    }

    // 先递归清理子进程树（含 SIGTERM→SIGKILL 回退），再强杀主进程
    use crate::gemini::kill_child_descendants;
    kill_child_descendants(client.pid);

    #[cfg(unix)]
    {
        // 子进程树已由 kill_child_descendants 处理，主进程直接 SIGKILL 确保退出
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(client.pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .arg("/PID")
            .arg(client.pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub fn claude_stream_client_matches(
    client: &ClaudeStreamClient,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    app: &AppHandle,
) -> bool {
    if client.exited.load(Ordering::SeqCst) || client.directory != directory {
        return false;
    }

    let desired_binary = resolve_claude_binary(app, requested_binary).display().to_string();
    let desired_proxy = proxy.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let desired_model = model.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let desired_effort = effort.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    let desired_session = session_id.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);

    if client.binary != desired_binary
        || client.proxy != desired_proxy
        || client.model != desired_model
        || client.effort != desired_effort
    {
        return false;
    }

    let current_session = client
        .session_id
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .or_else(|| client.resume_session.clone());

    match (current_session.as_deref(), desired_session.as_deref()) {
        (_, None) => true,
        (Some(current), Some(expected)) => current == expected,
        (None, Some(_)) => false,
    }
}

pub fn ensure_claude_stream_client(
    app: &AppHandle,
    state: &RuntimeState,
    run_id: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<ClaudeStreamClient>, String> {
    let existing = with_claude_state(state, run_id, |claude| claude.client.clone())?;

    if let Some(client) = existing {
        if claude_stream_client_matches(
            &client,
            directory,
            session_id,
            model,
            effort,
            requested_binary,
            proxy,
            app,
        ) {
            return Ok(client);
        }

        kill_claude_stream_client(&client);
    }

    let client = spawn_claude_stream_client(
        app,
        directory,
        session_id,
        model,
        effort,
        requested_binary,
        proxy,
    )?;

    with_claude_state(state, run_id, |claude| {
        claude.client = Some(client.clone());
    })?;
    Ok(client)
}

pub fn run_claude_stream_turn(
    app: &AppHandle,
    state: &RuntimeState,
    run_id: &str,
    prompt: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    let client = ensure_claude_stream_client(
        app,
        state,
        run_id,
        directory,
        session_id,
        model,
        effort,
        requested_binary,
        proxy,
    )?;

    if client.exited.load(Ordering::SeqCst) {
        let detail = client
            .exit_detail
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .unwrap_or_else(|| "Claude Code \u{4f1a}\u{8bdd}\u{5c1a}\u{672a}\u{5c31}\u{7eea}\u{3002}".to_string());
        return Err(detail);
    }

    let (tx, rx) = mpsc::channel();
    {
        let mut pending_turn = client
            .pending_turn
            .lock()
            .map_err(|_| "Failed to lock Claude pending turn state.".to_string())?;
        if pending_turn.is_some() {
            return Err("Claude Code \u{5f53}\u{524d}\u{4ecd}\u{5728}\u{5904}\u{7406}\u{4e0a}\u{4e00}\u{6761}\u{8bf7}\u{6c42}\u{3002}".to_string());
        }
        *pending_turn = Some(ClaudePendingTurn {
            stream_id: stream_id.map(ToOwned::to_owned),
            waiter: tx,
        });
    }

    if let Ok(mut fatal_error) = client.fatal_error.lock() {
        *fatal_error = None;
    }
    if let Ok(mut last_message) = client.last_message.lock() {
        last_message.clear();
    }

    let payload = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": prompt,
        }
    })
    .to_string();

    {
        let mut stdin = client
            .stdin
            .lock()
            .map_err(|_| "Failed to lock Claude Code stdin.".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| format!("Failed to write prompt to Claude Code stream: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Claude Code stream prompt: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Failed to flush Claude Code stream prompt: {error}"))?;
    }

    match rx.recv_timeout(CODEX_TURN_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = take_claude_pending_turn(&client.pending_turn);
            Err("Claude Code \u{54cd}\u{5e94}\u{8d85}\u{65f6}\u{3002}".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

pub fn run_claude_probe(
    app: &AppHandle,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("default")
        .arg("--no-session-persistence");

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort.filter(|value| !value.trim().is_empty()) {
        command.arg("--effort").arg(effort);
    }

    apply_proxy_env(&mut command, proxy);

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Claude Code probe: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(b"Reply with exactly OK.")
            .map_err(|error| format!("Failed to write probe prompt to Claude Code CLI: {error}"))?;
    }
    drop(child.stdin.take());

    let output = wait_child_output_with_timeout(child, CLI_VERIFY_TIMEOUT)?;
    let stdout = trim_output(&output.stdout);
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));

    let mut events = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            events.push(event);
        }
    }
    let message = extract_claude_last_message(&events);

    if !output.status.success() {
        return Err(if !message.trim().is_empty() {
            message
        } else if !stderr.is_empty() {
            stderr
        } else {
            stdout
        });
    }

    Ok(if message.trim().is_empty() {
        "Claude Code \u{8bf7}\u{6c42}\u{5df2}\u{5b8c}\u{6210}\u{ff0c}\u{4f46}\u{6ca1}\u{6709}\u{8fd4}\u{56de}\u{6700}\u{7ec8}\u{6d88}\u{606f}\u{3002}".to_string()
    } else {
        message
    })
}
