// Gemini ACP (Agent Client Protocol) 子系统。
// 通过 gemini-acp-runner.mjs 驱动 Gemini CLI 的 session/probe/models/auth 模式，
// 管理审批流、运行时子进程清理、登录认证检测。

use crate::types::*;
use crate::utils::*;
use crate::claude::kill_claude_stream_client;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

// ---------------------------------------------------------------------------
// Gemini 状态管理
// ---------------------------------------------------------------------------

pub fn next_gemini_run_id(state: &RuntimeState) -> Result<String, String> {
    let mut gemini = state
        .gemini
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?;
    gemini.next_run_id += 1;
    Ok(format!("gemini-run-{}", gemini.next_run_id))
}

pub fn register_gemini_run(
    state: &RuntimeState,
    run_id: &str,
    run: Arc<GeminiAcpRun>,
) -> Result<(), String> {
    state
        .gemini
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?
        .active_runs
        .insert(run_id.to_string(), run);
    Ok(())
}

pub fn clear_gemini_run(state: &RuntimeState, run_id: &str) {
    if let Ok(mut gemini) = state.gemini.lock() {
        gemini.active_runs.remove(run_id);
        gemini
            .pending_approvals
            .retain(|_, approval| approval.run_id.as_deref() != Some(run_id));
    }
}

pub fn gemini_pending_approvals(state: &RuntimeState, session_id: Option<&str>) -> Result<Vec<Value>, String> {
    let approvals = state
        .gemini
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?;
    let requested_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    Ok(
        approvals
            .pending_approvals
            .values()
            .filter_map(|approval| {
                if let Some(requested) = requested_session.as_deref() {
                    let block_session = approval
                        .block
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    if block_session != Some(requested) {
                        return None;
                    }
                }
                Some(approval.block.clone())
            })
            .collect(),
    )
}

pub fn reply_gemini_approval(
    state: &RuntimeState,
    approval_id: &str,
    decision: &str,
) -> Result<Value, String> {
    let (approval, run, client) = {
        let mut gemini = state
            .gemini
            .lock()
            .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?;
        let approval = gemini
            .pending_approvals
            .remove(approval_id)
            .ok_or_else(|| "Unable to find the requested Gemini approval.".to_string())?;
        let run = approval
            .run_id
            .as_deref()
            .and_then(|run_id| gemini.active_runs.get(run_id).cloned());
        let client = if approval.run_id.is_none() {
            gemini.client.clone()
        } else {
            None
        };
        (approval, run, client)
    };

    let target = run
        .or(client)
        .ok_or_else(|| "Gemini ACP session is no longer running.".to_string())?;

    target.send_control(&json!({
        "type": "approval",
        "approvalId": approval.approval_id,
        "decision": match decision {
            "reject" | "cancel" | "deny" => "reject",
            "session" => "session",
            _ => "once"
        }
    }))?;

    Ok(json!({
        "ok": true,
        "approvalId": approval_id
    }))
}

// ---------------------------------------------------------------------------
// 进程清理
// ---------------------------------------------------------------------------

pub fn kill_child_descendants(pid: u32) {
    #[cfg(unix)]
    {
        fn child_process_ids(parent_pid: u32) -> Vec<u32> {
            let output = match Command::new("pgrep")
                .arg("-P")
                .arg(parent_pid.to_string())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .output()
            {
                Ok(result) => result,
                Err(_) => return Vec::new(),
            };

            if !output.status.success() {
                return Vec::new();
            }

            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        }

        fn descendant_process_ids(root_pid: u32) -> Vec<u32> {
            let mut pending = vec![root_pid];
            let mut descendants = Vec::new();

            while let Some(current_pid) = pending.pop() {
                let children = child_process_ids(current_pid);
                for child_pid in children {
                    descendants.push(child_pid);
                    pending.push(child_pid);
                }
            }

            descendants
        }

        let descendants = descendant_process_ids(pid);
        for child_pid in descendants.iter().rev() {
            let _ = Command::new("kill")
                .arg("-TERM")
                .arg(child_pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        std::thread::sleep(Duration::from_millis(120));
        for child_pid in descendants.iter().rev() {
            let _ = Command::new("kill")
                .arg("-KILL")
                .arg(child_pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(unix)]
pub fn cleanup_stale_gemini_orphans(app: &AppHandle) {
    let node_binary = resolve_node_binary(app);
    let node_path = node_binary.to_string_lossy().to_string();
    let runner_marker = resolve_project_root(app)
        .ok()
        .map(|root| root.join("app/server/gemini-acp-runner.mjs"))
        .map(|path| path.to_string_lossy().to_string());
    let output = match Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,command="])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(result) => result,
        Err(_) => return,
    };

    if !output.status.success() {
        return;
    }

    let current_pid = std::process::id();
    let mut target_pids = BTreeSet::new();
    for raw_line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let mut parts = line.splitn(3, char::is_whitespace).filter(|part| !part.is_empty());
        let Some(pid_text) = parts.next() else {
            continue;
        };
        let Some(ppid_text) = parts.next() else {
            continue;
        };
        let Some(command) = parts.next() else {
            continue;
        };

        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let Ok(ppid) = ppid_text.parse::<u32>() else {
            continue;
        };

        if pid == current_pid || ppid != 1 || !command.contains(&node_path) {
            continue;
        }

        let is_runner = runner_marker
            .as_ref()
            .map(|marker| command.contains(marker))
            .unwrap_or(false);
        let is_gemini_acp = command.contains("/gemini/package/dist/index.js --acp")
            || command.contains("\\gemini\\package\\dist\\index.js --acp");

        if is_runner || is_gemini_acp {
            target_pids.insert(pid);
        }
    }

    for pid in target_pids {
        kill_child_descendants(pid);
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(Duration::from_millis(80));
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(unix))]
pub fn cleanup_stale_gemini_orphans(_app: &AppHandle) {}

// ---------------------------------------------------------------------------
// impl GeminiAcpRun
// ---------------------------------------------------------------------------

impl GeminiAcpRun {
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            kill_child_descendants(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn send_control(&self, value: &Value) -> Result<(), String> {
        let line = serde_json::to_string(value)
            .map_err(|error| format!("Failed to encode Gemini ACP control message: {error}"))?;
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Failed to lock Gemini ACP stdin.".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|error| format!("Failed to write Gemini ACP control message: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Gemini ACP control message: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Failed to flush Gemini ACP control message: {error}"))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Gemini 配置/认证
// ---------------------------------------------------------------------------

pub fn gemini_home_dir() -> Option<PathBuf> {
    user_home_dir().map(|home| home.join(".gemini"))
}

pub fn read_gemini_auth_snapshot(cwd: &Path) -> GeminiAuthSnapshot {
    let mut snapshot = GeminiAuthSnapshot::default();

    let mut settings_candidates = vec![cwd.join(".gemini").join("settings.json")];
    if let Some(home) = gemini_home_dir() {
        settings_candidates.push(home.join("settings.json"));
    }

    for candidate in settings_candidates {
        let Ok(content) = fs::read_to_string(candidate) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        snapshot.selected_type = read_json_string_at(&value, &["security", "auth", "selectedType"]);
        if snapshot.selected_type.is_some() {
            break;
        }
    }

    if let Some(home) = gemini_home_dir() {
        let google_accounts_path = home.join("google_accounts.json");
        if let Ok(content) = fs::read_to_string(google_accounts_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&content) {
                snapshot.active_google_account = read_json_string_at(&value, &["active"]);
            }
        }

        snapshot.has_oauth_creds = home.join("oauth_creds.json").exists();
    }

    snapshot
}

pub fn normalize_gemini_auth_type(value: Option<String>) -> Option<String> {
    let auth = value?.trim().to_lowercase();
    match auth.as_str() {
        "oauth-personal" | "login_with_google" | "google" | "oauth" => {
            Some("google-login".to_string())
        }
        "gemini-api-key" | "use_gemini" => Some("gemini-api-key".to_string()),
        "vertex-ai" | "compute-adc" | "cloud-shell" => Some("vertex-ai".to_string()),
        _ if !auth.is_empty() => Some(auth),
        _ => None,
    }
}

pub fn gemini_auth_label(value: &str) -> String {
    match value {
        "google-login" => "Google \u{767b}\u{5f55}".to_string(),
        "gemini-api-key" => "Gemini API Key".to_string(),
        "vertex-ai" => "Vertex AI".to_string(),
        other => other.to_string(),
    }
}

pub fn read_gemini_default_model(cwd: &Path) -> Option<String> {
    let mut candidates = vec![cwd.join(".gemini").join("settings.json")];
    if let Some(home) = gemini_home_dir() {
        candidates.push(home.join("settings.json"));
    }

    for candidate in candidates {
        let Ok(content) = fs::read_to_string(candidate) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        if let Some(model) = read_json_string_at(&value, &["model"]) {
            return Some(model);
        }
        if let Some(model) = read_json_string_at(&value, &["general", "model"]) {
            return Some(model);
        }
        if let Some(model) = read_json_string_at(&value, &["core", "model"]) {
            return Some(model);
        }
    }

    None
}

pub fn gemini_status_snapshot(app: &AppHandle, requested_binary: Option<&str>) -> Result<CliRuntimeStatus, String> {
    let root = resolve_project_root(app)?;
    let launch = resolve_gemini_launch(app, requested_binary);
    let version = launch
        .args
        .first()
        .and_then(|entry| {
            let entry = PathBuf::from(entry);
            let package_root = entry.parent()?.parent()?;
            read_package_version(package_root)
        })
        .or_else(|| command_version_with_args(&launch.program, &launch.args, "--version", &root));
    let installed = version.is_some();
    let auth_snapshot = read_gemini_auth_snapshot(&root);
    let configured_auth = normalize_gemini_auth_type(auth_snapshot.selected_type.clone());
    let auth_method = configured_auth.clone();
    let logged_in = match auth_method.as_deref() {
        Some("google-login") => auth_snapshot.has_oauth_creds || auth_snapshot.active_google_account.is_some(),
        Some("gemini-api-key") | Some("vertex-ai") => true,
        Some(_) => true,
        None => false,
    };

    let login_status = if !installed {
        "\u{672a}\u{68c0}\u{6d4b}\u{5230} Gemini CLI\u{3002}".to_string()
    } else if matches!(configured_auth.as_deref(), Some("google-login")) && logged_in {
        let account_hint = auth_snapshot
            .active_google_account
            .as_deref()
            .map(|email| format!("\u{ff08}{email}\u{ff09}"))
            .unwrap_or_default();
        format!("\u{68c0}\u{6d4b}\u{5230}\u{5b98}\u{65b9} Google \u{767b}\u{5f55}{account_hint}\u{3002}\u{8bf7}\u{901a}\u{8fc7}\u{201c}\u{9a8c}\u{8bc1}\u{8fde}\u{63a5}\u{201d}\u{786e}\u{8ba4}\u{5f53}\u{524d}\u{8ba4}\u{8bc1}\u{53ef}\u{7528}\u{3002}")
    } else if matches!(configured_auth.as_deref(), Some("google-login")) {
        "\u{5f53}\u{524d} Gemini CLI \u{5df2}\u{914d}\u{7f6e}\u{4e3a}\u{5b98}\u{65b9} Google \u{767b}\u{5f55}\u{ff0c}\u{4f46}\u{8fd8}\u{672a}\u{5b8c}\u{6210}\u{767b}\u{5f55}\u{3002}\u{8bf7}\u{70b9}\u{201c}\u{6253}\u{5f00}\u{767b}\u{5f55}\u{7ec8}\u{7aef}\u{201d}\u{5b8c}\u{6210}\u{767b}\u{5f55}\u{3002}".to_string()
    } else if let Some(method) = auth_method.as_deref() {
        format!(
            "\u{5f53}\u{524d}\u{68c0}\u{6d4b}\u{5230} {} \u{914d}\u{7f6e}\u{3002}\u{8f6f}\u{4ef6}\u{9ed8}\u{8ba4}\u{66f4}\u{63a8}\u{8350}\u{5b98}\u{65b9} Google \u{767b}\u{5f55}\u{ff1b}\u{5982}\u{9700}\u{5207}\u{56de}\u{ff0c}\u{8bf7}\u{5728} Gemini CLI \u{4e2d}\u{91cd}\u{65b0}\u{9009}\u{62e9}\u{767b}\u{5f55}\u{65b9}\u{5f0f}\u{3002}",
            gemini_auth_label(method)
        )
    } else {
        "\u{9ed8}\u{8ba4}\u{63a8}\u{8350}\u{4f7f}\u{7528}\u{5b98}\u{65b9} Google \u{767b}\u{5f55}\u{3002}\u{8bf7}\u{70b9}\u{201c}\u{6253}\u{5f00}\u{767b}\u{5f55}\u{7ec8}\u{7aef}\u{201d}\u{5b8c}\u{6210}\u{767b}\u{5f55}\u{ff0c}\u{6216}\u{5728} CLI \u{4e2d}\u{660e}\u{786e}\u{9009}\u{62e9}\u{5176}\u{4ed6}\u{8ba4}\u{8bc1}\u{65b9}\u{5f0f}\u{3002}".to_string()
    };

    Ok(CliRuntimeStatus {
        installed,
        version,
        binary: launch.display,
        logged_in,
        login_status,
        auth_method: auth_method.map(|method| gemini_auth_label(&method)),
        default_model: read_gemini_default_model(&root),
        default_effort: None,
    })
}

pub fn clear_gemini_selected_auth_type() {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(".gemini").join("settings.json"));
    }
    if let Some(home) = gemini_home_dir() {
        candidates.push(home.join("settings.json"));
    }

    for candidate in candidates {
        let Ok(content) = fs::read_to_string(&candidate) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };

        let Some(security) = value.get_mut("security").and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(auth) = security.get_mut("auth").and_then(Value::as_object_mut) else {
            continue;
        };

        if auth.remove("selectedType").is_none() {
            continue;
        }

        if let Ok(serialized) = serde_json::to_string_pretty(&value) {
            let _ = fs::write(candidate, format!("{serialized}\n"));
        }
    }
}

// ---------------------------------------------------------------------------
// Stream 客户端辅助
// ---------------------------------------------------------------------------

pub fn take_gemini_pending_turn(
    pending_turn: &Arc<Mutex<Option<GeminiPendingTurn>>>,
) -> Option<GeminiPendingTurn> {
    pending_turn.lock().ok().and_then(|mut guard| guard.take())
}

pub fn current_gemini_stream_id(client: &GeminiAcpRun) -> Option<String> {
    client
        .pending_turn
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|turn| turn.stream_id.clone()))
}

pub fn gemini_launch_signature(launch: &CliLaunch) -> String {
    let mut parts = Vec::<String>::with_capacity(1 + launch.args.len());
    parts.push(launch.program.display().to_string());
    parts.extend(launch.args.iter().cloned());
    parts.join("\u{1f}")
}

pub fn set_gemini_client_fatal_error(client: &GeminiAcpRun, message: String) {
    if let Ok(mut fatal_error) = client.fatal_error.lock() {
        *fatal_error = Some(message);
    }
}

// ---------------------------------------------------------------------------
// Exec / Probe
// ---------------------------------------------------------------------------

pub fn run_gemini_exec(
    app: &AppHandle,
    state: &RuntimeState,
    prompt: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    run_gemini_stream_turn(
        app,
        state,
        prompt,
        directory,
        session_id,
        model,
        requested_binary,
        proxy,
        stream_id
    )
}

pub fn run_gemini_probe(
    app: &AppHandle,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let root = resolve_project_root(app)?;
    let (_, output) = run_gemini_acp_mode(
        app,
        None,
        "probe",
        Some("Reply with exactly OK."),
        root.to_string_lossy().as_ref(),
        None,
        model,
        requested_binary,
        proxy,
        None,
    )?;
    Ok(output)
}

// ---------------------------------------------------------------------------
// ACP stdout 行处理
// ---------------------------------------------------------------------------

pub fn handle_gemini_acp_stdout_line(
    app: &AppHandle,
    run_id: Option<&str>,
    run: &Arc<GeminiAcpRun>,
    stream_id: Option<&str>,
    line: &str,
) {
    if let Some(stream_id) = stream_id {
        emit_cli_stream_line(app, "gemini", stream_id, "stdout", line);
    }

    let Ok(event) = serde_json::from_str::<Value>(line) else {
        return;
    };

    match event.get("type").and_then(Value::as_str) {
        Some("designcode.session") => {
            if let Some(session_id) = event.get("sessionId").and_then(Value::as_str) {
                if let Ok(mut current) = run.session_id.lock() {
                    *current = Some(session_id.to_string());
                }
            }
        }
        Some("designcode.ready") => {
            if let Some(session_id) = event.get("sessionId").and_then(Value::as_str) {
                if let Ok(mut current) = run.session_id.lock() {
                    *current = Some(session_id.to_string());
                }
            }
            if let Some(waiter) = run
                .ready_waiter
                .lock()
                .ok()
                .and_then(|mut value| value.take())
            {
                let session_id = run
                    .session_id
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                let _ = waiter.send(Ok(session_id));
            }
        }
        Some("designcode.result") => {
            if let Some(session_id) = event.get("sessionId").and_then(Value::as_str) {
                if let Ok(mut current) = run.session_id.lock() {
                    *current = Some(session_id.to_string());
                }
            }
            if let Some(output) = event.get("output").and_then(Value::as_str) {
                if let Ok(mut last_message) = run.last_message.lock() {
                    *last_message = output.to_string();
                }
            }
        }
        Some("designcode.prompt_result") => {
            if let Some(session_id) = event.get("sessionId").and_then(Value::as_str) {
                if let Ok(mut current) = run.session_id.lock() {
                    *current = Some(session_id.to_string());
                }
            }
            if let Some(output) = event.get("output").and_then(Value::as_str) {
                if let Ok(mut last_message) = run.last_message.lock() {
                    *last_message = output.to_string();
                }
            }

            let prompt_id = event
                .get("promptId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let matches_prompt = run
                .pending_turn
                .lock()
                .ok()
                .and_then(|value| value.as_ref().map(|turn| {
                    prompt_id.map(|id| id == turn.prompt_id.as_str()).unwrap_or(true)
                }))
                .unwrap_or(false);

            if matches_prompt {
                if let Some(turn) = take_gemini_pending_turn(&run.pending_turn) {
                    let session_id = run
                        .session_id
                        .lock()
                        .ok()
                        .and_then(|value| value.clone());
                    let output = run
                        .last_message
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    let _ = turn.waiter.send(Ok((session_id, output)));
                }
            }
        }
        Some("designcode.error") => {
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| "Gemini ACP \u{6267}\u{884c}\u{5931}\u{8d25}\u{3002}".to_string());
            if let Ok(mut fatal_error) = run.fatal_error.lock() {
                *fatal_error = Some(message);
            }
        }
        Some("designcode.prompt_error") => {
            let message = event
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| "Gemini ACP \u{6267}\u{884c}\u{5931}\u{8d25}\u{3002}".to_string());
            set_gemini_client_fatal_error(run, message.clone());
            if let Some(turn) = take_gemini_pending_turn(&run.pending_turn) {
                let _ = turn.waiter.send(Err(message));
            }
        }
        Some("designcode.block") => {
            let Some(block) = event.get("block").cloned() else {
                return;
            };
            if block.get("type").and_then(Value::as_str) != Some("confirm") {
                return;
            }

            let Some(approval_id) = block
                .get("approvalId")
                .or_else(|| block.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                return;
            };

            let interactive = block
                .get("interactive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let resolved = matches!(
                block.get("status").and_then(Value::as_str),
                Some("resolved") | Some("success") | Some("error")
            );

            if let Ok(mut gemini) = app.state::<RuntimeState>().gemini.lock() {
                if interactive && !resolved {
                    gemini.pending_approvals.insert(
                        approval_id.to_string(),
                        GeminiPendingApproval {
                            approval_id: approval_id.to_string(),
                            run_id: run_id.map(ToOwned::to_owned),
                            block,
                        },
                    );
                } else {
                    gemini.pending_approvals.remove(approval_id);
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// ACP mode (one-shot)
// ---------------------------------------------------------------------------

pub fn run_gemini_acp_mode(
    app: &AppHandle,
    state: Option<&RuntimeState>,
    mode: &str,
    prompt: Option<&str>,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    let root = resolve_project_root(app)?;
    let script = root.join("app/server/gemini-acp-runner.mjs");
    let sdk_path = resolve_gemini_acp_sdk_path(app)?;
    let node_binary = resolve_node_binary(app);
    let launch = resolve_gemini_launch(app, requested_binary);
    let run_id = state
        .map(next_gemini_run_id)
        .transpose()?;

    let mut command = Command::new(&node_binary);
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clear_gemini_auth_env(&mut command);
    apply_proxy_env(&mut command, proxy);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Gemini ACP runner: {error}"))?;

    let init_payload = json!({
        "mode": mode,
        "sdkPath": sdk_path,
        "cwd": directory,
        "sessionId": session_id.filter(|value| !value.trim().is_empty()),
        "prompt": prompt.unwrap_or_default(),
        "model": model.filter(|value| !value.trim().is_empty()),
        "approvalMode": "autoEdit",
        "authMethod": "oauth-personal",
        "launchProgram": launch.program,
        "launchArgs": launch.args,
    });

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Gemini ACP runner stdin is not available.".to_string())?;
        stdin
            .write_all(init_payload.to_string().as_bytes())
            .map_err(|error| format!("Failed to write Gemini ACP runner payload: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Gemini ACP runner payload: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Failed to flush Gemini ACP runner payload: {error}"))?;
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Gemini ACP runner stdin is not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Gemini ACP runner stdout is not available.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Gemini ACP runner stderr is not available.".to_string())?;

    let run = Arc::new(GeminiAcpRun {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        session_id: Arc::new(Mutex::new(session_id.map(ToOwned::to_owned))),
        last_message: Arc::new(Mutex::new(String::new())),
        fatal_error: Arc::new(Mutex::new(None)),
        pending_turn: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        exit_detail: Arc::new(Mutex::new(None)),
        directory: directory.to_string(),
        binary: gemini_launch_signature(&launch),
        proxy: proxy
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        resume_session: session_id.map(ToOwned::to_owned),
        ready_waiter: Arc::new(Mutex::new(None)),
    });

    if let (Some(runtime), Some(active_run_id)) = (state, run_id.as_deref()) {
        register_gemini_run(runtime, active_run_id, run.clone())?;
    }

    let stdout_handle = {
        let app = app.clone();
        let run = run.clone();
        let run_id = run_id.clone();
        let stream = stream_id.map(ToOwned::to_owned);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(active_run_id) = run_id.as_deref() {
                    handle_gemini_acp_stdout_line(
                        &app,
                        Some(active_run_id),
                        &run,
                        stream.as_deref(),
                        &line,
                    );
                } else if let Some(stream_id) = stream.as_deref() {
                    emit_cli_stream_line(&app, "gemini", stream_id, "stdout", &line);
                }
            }
        })
    };

    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_handle = {
        let lines = stderr_lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Some(safe_line) = sanitize_gemini_stderr_line(&line) {
                    if let Ok(mut bucket) = lines.lock() {
                        bucket.push(safe_line);
                    }
                }
            }
        })
    };

    let status = run
        .child
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP child.".to_string())?
        .wait()
        .map_err(|error| format!("Failed to read Gemini ACP output: {error}"))?;

    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    if let Some(active_run_id) = run_id.as_deref() {
        if let Some(runtime) = state {
            clear_gemini_run(runtime, active_run_id);
        }
    }

    let fatal_error = run
        .fatal_error
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP error state.".to_string())?
        .clone();
    let next_session_id = run
        .session_id
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP session state.".to_string())?
        .clone()
        .or_else(|| session_id.map(ToOwned::to_owned));
    let output = run
        .last_message
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP output state.".to_string())?
        .clone();
    let stderr_summary = stderr_lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();

    if let Some(error) = fatal_error {
        return Err(error);
    }

    if !status.success() {
        return Err(if !output.trim().is_empty() {
            output
        } else if !stderr_summary.trim().is_empty() {
            stderr_summary
        } else {
            "Gemini ACP \u{8bf7}\u{6c42}\u{5931}\u{8d25}\u{3002}".to_string()
        });
    }

    Ok((
        next_session_id,
        if output.trim().is_empty() {
            match mode {
                "auth" => "Gemini ACP \u{767b}\u{5f55}\u{5df2}\u{5b8c}\u{6210}\u{3002}".to_string(),
                "probe" => "OK".to_string(),
                _ => "Gemini ACP \u{8bf7}\u{6c42}\u{5df2}\u{5b8c}\u{6210}\u{ff0c}\u{4f46}\u{6ca1}\u{6709}\u{8fd4}\u{56de}\u{6700}\u{7ec8}\u{6d88}\u{606f}\u{3002}".to_string(),
            }
        } else {
            output
        },
    ))
}

// ---------------------------------------------------------------------------
// 客户端生命周期
// ---------------------------------------------------------------------------

pub fn kill_gemini_acp_client(client: &GeminiAcpRun) {
    client.stop();
}

pub fn shutdown_runtime_children(app: &AppHandle) {
    let state = app.state::<RuntimeState>();

    // 使用 try_lock 避免阻塞：如果其他线程正在持有锁做长操作（如健康检查），
    // lock() 会无限期等待导致退出卡住。try_lock 拿不到就跳过，继续清理其他运行时。
    // 多 tab 模式下遍历每个 run_id 各自的 OpencodeState，逐一杀掉子进程并收集端口。
    let runtime: &RuntimeState = state.inner();
    let mut opencode_ports: Vec<u16> = Vec::new();
    drain_opencode_states(runtime, |_run_id, opencode| {
        if let Some(child) = opencode.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        opencode_ports.push(opencode.port);
        opencode.child = None;
        opencode.session_id = None;
        opencode.managed = false;
    });
    opencode_ports.push(1455);
    let _ = kill_opencode_listeners(&opencode_ports);

    for client in drain_codex_clients(runtime) {
        client.stop();
    }

    for client in drain_claude_clients(runtime) {
        kill_claude_stream_client(&client);
    }

    let (gemini_client, active_runs) = match state.gemini.try_lock() {
        Ok(mut gemini) => {
            let client = gemini.client.take();
            let runs = gemini.active_runs.drain().map(|(_, run)| run).collect::<Vec<_>>();
            gemini.pending_approvals.clear();
            (client, runs)
        }
        Err(_) => (None, Vec::new()),
    };

    if let Some(client) = gemini_client {
        kill_gemini_acp_client(&client);
    }
    for run in active_runs {
        run.stop();
    }
}

pub fn gemini_acp_client_matches(
    app: &AppHandle,
    client: &GeminiAcpRun,
    directory: &str,
    session_id: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> bool {
    if client.exited.load(Ordering::SeqCst) || client.directory != directory {
        return false;
    }

    let desired_launch = resolve_gemini_launch(app, requested_binary);
    let desired_binary = gemini_launch_signature(&desired_launch);
    let desired_proxy = proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let desired_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if client.binary != desired_binary || client.proxy != desired_proxy {
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

pub fn spawn_gemini_acp_client(
    app: &AppHandle,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<GeminiAcpRun>, String> {
    let root = resolve_project_root(app)?;
    let script = root.join("app/server/gemini-acp-runner.mjs");
    let sdk_path = resolve_gemini_acp_sdk_path(app)?;
    let node_binary = resolve_node_binary(app);
    let launch = resolve_gemini_launch(app, requested_binary);
    let binary_signature = gemini_launch_signature(&launch);
    let model_text = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let proxy_text = proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let resume_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let mut command = Command::new(&node_binary);
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clear_gemini_auth_env(&mut command);
    apply_proxy_env(&mut command, proxy_text.as_deref());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Gemini ACP runner: {error}"))?;

    let init_payload = json!({
        "mode": "session",
        "sdkPath": sdk_path,
        "cwd": directory,
        "sessionId": resume_session.clone(),
        "model": model_text.clone(),
        "approvalMode": "autoEdit",
        "authMethod": "oauth-personal",
        "launchProgram": launch.program,
        "launchArgs": launch.args,
    });

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "Gemini ACP runner stdin is not available.".to_string())?;
        stdin
            .write_all(init_payload.to_string().as_bytes())
            .map_err(|error| format!("Failed to write Gemini ACP runner payload: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Gemini ACP runner payload: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Failed to flush Gemini ACP runner payload: {error}"))?;
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Gemini ACP runner stdin is not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Gemini ACP runner stdout is not available.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Gemini ACP runner stderr is not available.".to_string())?;

    let (ready_tx, ready_rx) = mpsc::channel();
    let client = Arc::new(GeminiAcpRun {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        session_id: Arc::new(Mutex::new(resume_session.clone())),
        last_message: Arc::new(Mutex::new(String::new())),
        fatal_error: Arc::new(Mutex::new(None)),
        pending_turn: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        exit_detail: Arc::new(Mutex::new(None)),
        directory: directory.to_string(),
        binary: binary_signature,
        proxy: proxy_text,
        resume_session,
        ready_waiter: Arc::new(Mutex::new(Some(ready_tx))),
    });

    {
        let app = app.clone();
        let client = client.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let stream_id = current_gemini_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(&app, "gemini", stream_id, "stdout", &line);
                }
                handle_gemini_acp_stdout_line(&app, None, &client, stream_id.as_deref(), &line);
            }
        });
    }

    {
        let app = app.clone();
        let client = client.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let Some(safe_line) = sanitize_gemini_stderr_line(&line) else {
                    continue;
                };
                let stream_id = current_gemini_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(&app, "gemini", stream_id, "stderr", &safe_line);
                }
            }
        });
    }

    {
        let client = client.clone();
        std::thread::spawn(move || {
            let status = client
                .child
                .lock()
                .map_err(|_| "Failed to lock Gemini ACP child.".to_string())
                .and_then(|mut child| {
                    child
                        .wait()
                        .map_err(|error| format!("Gemini ACP runner exited unexpectedly: {error}"))
                });
            client.exited.store(true, Ordering::SeqCst);
            let detail = match status {
                Ok(exit_status) if exit_status.success() => None,
                Ok(exit_status) => Some(format!("Gemini ACP \u{4f1a}\u{8bdd}\u{5df2}\u{7ed3}\u{675f}\u{ff08}exit code: {}\u{ff09}\u{3002}", exit_status)),
                Err(error) => Some(error),
            };

            if let Some(message) = detail.clone() {
                if let Ok(mut exit_detail) = client.exit_detail.lock() {
                    *exit_detail = Some(message.clone());
                }
                set_gemini_client_fatal_error(&client, message.clone());
                if let Some(waiter) = client
                    .ready_waiter
                    .lock()
                    .ok()
                    .and_then(|mut value| value.take())
                {
                    let _ = waiter.send(Err(message.clone()));
                }
                if let Some(turn) = take_gemini_pending_turn(&client.pending_turn) {
                    let _ = turn.waiter.send(Err(message));
                }
            }
        });
    }

    match ready_rx.recv_timeout(GEMINI_ACP_READY_TIMEOUT) {
        Ok(result) => {
            result?;
            Ok(client)
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            client.stop();
            Err(format!(
                "Gemini ACP \u{4f1a}\u{8bdd}\u{542f}\u{52a8}\u{8d85}\u{65f6}\u{ff08}{}s\u{ff09}\u{3002}",
                GEMINI_ACP_READY_TIMEOUT.as_secs()
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            client.stop();
            Err("Gemini ACP \u{4f1a}\u{8bdd}\u{542f}\u{52a8}\u{5931}\u{8d25}\u{3002}".to_string())
        }
    }
}

pub fn ensure_gemini_acp_client(
    app: &AppHandle,
    state: &RuntimeState,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<GeminiAcpRun>, String> {
    let existing = {
        let gemini = state
            .gemini
            .lock()
            .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?;
        gemini.client.clone()
    };

    if let Some(client) = existing {
        if gemini_acp_client_matches(app, &client, directory, session_id, requested_binary, proxy) {
            return Ok(client);
        }
        kill_gemini_acp_client(&client);
    }

    let client = spawn_gemini_acp_client(
        app,
        directory,
        session_id,
        model,
        requested_binary,
        proxy,
    )?;

    let mut gemini = state
        .gemini
        .lock()
        .map_err(|_| "Failed to lock Gemini ACP state.".to_string())?;
    gemini.client = Some(client.clone());
    Ok(client)
}

pub fn run_gemini_stream_turn(
    app: &AppHandle,
    state: &RuntimeState,
    prompt: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    let client = ensure_gemini_acp_client(
        app,
        state,
        directory,
        session_id,
        model,
        requested_binary,
        proxy,
    )?;

    if client.exited.load(Ordering::SeqCst) {
        let detail = client
            .exit_detail
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .unwrap_or_else(|| "Gemini ACP \u{4f1a}\u{8bdd}\u{5c1a}\u{672a}\u{5c31}\u{7eea}\u{3002}".to_string());
        return Err(detail);
    }

    let prompt_id = next_gemini_run_id(state)?;
    let (tx, rx) = mpsc::channel();
    {
        let mut pending_turn = client
            .pending_turn
            .lock()
            .map_err(|_| "Failed to lock Gemini pending turn state.".to_string())?;
        if pending_turn.is_some() {
            return Err("Gemini \u{5f53}\u{524d}\u{4ecd}\u{5728}\u{5904}\u{7406}\u{4e0a}\u{4e00}\u{6761}\u{8bf7}\u{6c42}\u{3002}".to_string());
        }
        *pending_turn = Some(GeminiPendingTurn {
            prompt_id: prompt_id.clone(),
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

    client.send_control(&json!({
        "type": "prompt",
        "promptId": prompt_id,
        "prompt": prompt,
        "model": model.filter(|value| !value.trim().is_empty()),
    }))?;

    match rx.recv_timeout(CODEX_TURN_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = take_gemini_pending_turn(&client.pending_turn);
            Err("Gemini \u{54cd}\u{5e94}\u{8d85}\u{65f6}\u{3002}".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Models / Auth
// ---------------------------------------------------------------------------

pub fn run_gemini_models(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<GeminiModelsResult, String> {
    let root = resolve_project_root(app)?;
    let script = root.join("app/server/gemini-acp-runner.mjs");
    let sdk_path = resolve_gemini_acp_sdk_path(app)?;
    let node_binary = resolve_node_binary(app);
    let launch = resolve_gemini_launch(app, requested_binary);

    let mut command = Command::new(&node_binary);
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    clear_gemini_auth_env(&mut command);
    apply_proxy_env(&mut command, proxy);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Gemini ACP models query: {error}"))?;

    let init_payload = json!({
        "mode": "models",
        "sdkPath": sdk_path,
        "cwd": root,
        "launchProgram": launch.program,
        "launchArgs": launch.args,
    });

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(init_payload.to_string().as_bytes())
            .map_err(|error| format!("Failed to write Gemini ACP models payload: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Gemini ACP models payload: {error}"))?;
    }
    drop(child.stdin.take());

    let output = wait_child_output_with_timeout(child, CLI_VERIFY_TIMEOUT)?;
    let stdout = trim_output(&output.stdout);
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));

    let mut available_models = Vec::new();
    let mut current_model_id = None;
    let mut fatal_error = None;

    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        match event.get("type").and_then(Value::as_str) {
            Some("designcode.models") => {
                current_model_id = event
                    .get("models")
                    .and_then(|models| models.get("currentModelId"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                available_models = event
                    .get("models")
                    .and_then(|models| models.get("availableModels"))
                    .and_then(Value::as_array)
                    .map(|models| {
                        models
                            .iter()
                            .filter_map(|item| {
                                let id = item.get("modelId").and_then(Value::as_str)?.trim();
                                if id.is_empty() {
                                    return None;
                                }
                                Some(GeminiModel {
                                    id: id.to_string(),
                                    name: item
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|value| !value.is_empty())
                                        .unwrap_or(id)
                                        .to_string(),
                                    description: item
                                        .get("description")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|value| !value.is_empty())
                                        .map(ToOwned::to_owned),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
            }
            Some("designcode.error") => {
                fatal_error = event
                    .get("message")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
            }
            _ => {}
        }
    }

    if let Some(error) = fatal_error {
        return Err(error);
    }
    if !output.status.success() {
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Gemini ACP \u{6a21}\u{578b}\u{5217}\u{8868}\u{83b7}\u{53d6}\u{5931}\u{8d25}\u{3002}".to_string()
        });
    }

    Ok(GeminiModelsResult {
        available_models,
        current_model_id,
    })
}

pub fn run_gemini_auth(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    clear_gemini_selected_auth_type();
    let root = resolve_project_root(app)?;
    let (_, output) = run_gemini_acp_mode(
        app,
        None,
        "auth",
        None,
        root.to_string_lossy().as_ref(),
        None,
        None,
        requested_binary,
        proxy,
        None,
    )?;
    Ok(output)
}
