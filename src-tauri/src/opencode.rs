// OpenCode 运行时子系统。
// 通过 HTTP API 与本地 OpenCode 进程通信，处理权限审批轮询、
// 会话快照、浏览器授权窗口等。

use crate::types::*;
use crate::utils::*;
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::watch;
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// HTTP 通信
// ---------------------------------------------------------------------------

pub async fn opencode_health(port: u16) -> bool {
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/app"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

pub async fn opencode_request_with_timeout(
    port: u16,
    method: Method,
    path: &str,
    body: Option<Value>,
    directory: Option<&str>,
    timeout: Duration,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}{path}");
    let mut request = client.request(method, url);

    if let Some(directory) = directory.filter(|value| !value.trim().is_empty()) {
        request = request.query(&[("directory", directory)]);
    }

    if let Some(payload) = body {
        request = request.json(&payload);
    }

    let response = request
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| format!("OpenCode request failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenCode returned {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Failed to decode OpenCode response: {error}"))
}

pub async fn opencode_request(
    port: u16,
    method: Method,
    path: &str,
    body: Option<Value>,
    directory: Option<&str>,
) -> Result<Value, String> {
    opencode_request_with_timeout(
        port,
        method,
        path,
        body,
        directory,
        Duration::from_secs(120),
    )
    .await
}

// ---------------------------------------------------------------------------
// 权限处理
// ---------------------------------------------------------------------------

pub fn extract_opencode_permission_entries(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }

    for key in ["items", "permissions", "requests", "data"] {
        if let Some(array) = value.get(key).and_then(Value::as_array) {
            return array.clone();
        }
    }

    Vec::new()
}

pub fn opencode_permission_id(value: &Value) -> Option<String> {
    read_nested_string(value, &["id"])
        .or_else(|| read_nested_string(value, &["permissionID"]))
        .or_else(|| read_nested_string(value, &["permissionId"]))
        .or_else(|| read_nested_string(value, &["requestID"]))
        .or_else(|| read_nested_string(value, &["requestId"]))
}

pub fn opencode_permission_session_id(value: &Value) -> Option<String> {
    read_nested_string(value, &["sessionID"])
        .or_else(|| read_nested_string(value, &["sessionId"]))
        .or_else(|| read_nested_string(value, &["session", "id"]))
}

pub fn opencode_permission_text(value: &Value) -> Option<String> {
    read_nested_string(value, &["message"])
        .or_else(|| read_nested_string(value, &["content"]))
        .or_else(|| read_nested_string(value, &["description"]))
        .or_else(|| read_nested_string(value, &["reason"]))
        .or_else(|| read_nested_string(value, &["details"]))
        .or_else(|| read_nested_string(value, &["prompt"]))
        .or_else(|| read_nested_string(value, &["metadata", "message"]))
        .or_else(|| read_nested_string(value, &["metadata", "reason"]))
}

pub fn opencode_permission_command(value: &Value) -> Option<String> {
    read_nested_string(value, &["command"])
        .or_else(|| read_nested_string(value, &["cmd"]))
        .or_else(|| read_nested_string(value, &["input", "command"]))
        .or_else(|| read_nested_string(value, &["metadata", "command"]))
}

pub fn opencode_permission_outcome(value: &Value) -> Option<String> {
    if let Some(reply) = read_nested_string(value, &["reply"]) {
        return Some(reply);
    }

    if let Some(response) = value.get("response") {
        if let Some(text) = response.as_str() {
            return Some(text.to_string());
        }
        if let Some(boolean) = response.as_bool() {
            return Some(if boolean { "once" } else { "reject" }.to_string());
        }
    }

    read_nested_string(value, &["status"])
}

pub fn filter_opencode_permissions(entries: Vec<Value>, session_id: Option<&str>) -> Vec<Value> {
    let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) else {
        return entries;
    };

    entries
        .into_iter()
        .filter(|entry| {
            opencode_permission_session_id(entry)
                .as_deref()
                .map(|value| value == session_id)
                .unwrap_or(true)
        })
        .collect()
}

pub async fn opencode_permissions_request(
    port: u16,
    session_id: Option<&str>,
    directory: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut last_error = None;

    match opencode_request(port, Method::GET, "/permission", None, directory).await {
        Ok(response) => {
            return Ok(filter_opencode_permissions(
                extract_opencode_permission_entries(&response),
                session_id,
            ))
        }
        Err(error) => {
            if !error.contains("404") {
                last_error = Some(error);
            }
        }
    }

    if let Some(session_id) = session_id {
        match opencode_request(
            port,
            Method::GET,
            &format!("/session/{session_id}"),
            None,
            directory,
        )
        .await
        {
            Ok(response) => {
                return Ok(filter_opencode_permissions(
                    extract_opencode_permission_entries(&response),
                    Some(session_id),
                ))
            }
            Err(error) => {
                if !error.contains("404") {
                    last_error = Some(error);
                }
            }
        }
    }

    if let Some(error) = last_error {
        return Err(error);
    }

    Ok(Vec::new())
}

pub fn opencode_permission_note(outcome: Option<&str>) -> Option<String> {
    match outcome.map(str::trim).filter(|value| !value.is_empty()) {
        Some("once") | Some("always") | Some("approved") | Some("allow") => {
            Some("\u{5df2}\u{786e}\u{8ba4}\u{6267}\u{884c}\u{3002}".to_string())
        }
        Some("reject") | Some("denied") | Some("deny") | Some("false") => {
            Some("\u{5df2}\u{62d2}\u{7edd}\u{6267}\u{884c}\u{3002}".to_string())
        }
        Some(status) if status.eq_ignore_ascii_case("resolved") => Some("\u{5ba1}\u{6279}\u{5df2}\u{5904}\u{7406}\u{3002}".to_string()),
        _ => None,
    }
}

pub fn opencode_permission_block(permission: &Value) -> Option<Value> {
    let approval_id = opencode_permission_id(permission)?;
    let outcome = opencode_permission_outcome(permission);
    let interactive = outcome.is_none();
    let title = read_nested_string(permission, &["title"])
        .or_else(|| read_nested_string(permission, &["name"]))
        .or_else(|| read_nested_string(permission, &["permission"]))
        .unwrap_or_else(|| "\u{9700}\u{8981}\u{786e}\u{8ba4}\u{6267}\u{884c}".to_string());
    let command = opencode_permission_command(permission);
    let content = [
        opencode_permission_text(permission),
        command
            .as_ref()
            .map(|value| format!("\u{547d}\u{4ee4}\u{ff1a}{value}")),
        read_nested_string(permission, &["path"]).map(|value| format!("\u{8def}\u{5f84}\u{ff1a}{value}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");

    Some(json!({
        "type": "designcode.block",
        "block": {
            "id": approval_id,
            "type": "confirm",
            "title": title,
            "content": if content.trim().is_empty() { "\u{5f53}\u{524d}\u{547d}\u{4ee4}\u{9700}\u{8981}\u{786e}\u{8ba4}\u{540e}\u{624d}\u{80fd}\u{7ee7}\u{7eed}\u{6267}\u{884c}\u{3002}".to_string() } else { content },
            "command": command,
            "status": if interactive { "waiting" } else { "resolved" },
            "interactive": interactive,
            "backend": "opencode",
            "approvalId": opencode_permission_id(permission),
            "sessionId": opencode_permission_session_id(permission),
            "note": opencode_permission_note(outcome.as_deref())
        }
    }))
}

pub fn opencode_permission_signature(permission: &Value) -> Option<String> {
    let approval_id = opencode_permission_id(permission)?;
    let status = opencode_permission_outcome(permission).unwrap_or_else(|| "waiting".to_string());
    Some(format!("{approval_id}:{status}"))
}

pub fn spawn_opencode_permission_poller(
    app: &AppHandle,
    port: u16,
    session_id: &str,
    directory: Option<&str>,
    stream_id: &str,
) -> (watch::Sender<bool>, tokio::task::JoinHandle<()>) {
    let app = app.clone();
    let session_id = session_id.to_string();
    let directory = directory.map(ToOwned::to_owned);
    let stream_id = stream_id.to_string();
    let (stop_tx, stop_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let mut seen = BTreeSet::new();

        loop {
            if let Ok(entries) = opencode_permissions_request(
                port,
                Some(session_id.as_str()),
                directory.as_deref(),
            )
            .await
            {
                for permission in entries {
                    let Some(signature) = opencode_permission_signature(&permission) else {
                        continue;
                    };
                    if !seen.insert(signature) {
                        continue;
                    }
                    if let Some(event) = opencode_permission_block(&permission) {
                        emit_cli_stream_json_event(&app, "opencode", &stream_id, &event);
                    }
                }
            }

            if *stop_rx.borrow() {
                break;
            }

            sleep(Duration::from_millis(900)).await;
        }
    });

    (stop_tx, handle)
}

pub async fn opencode_reply_permission(
    port: u16,
    session_id: Option<&str>,
    approval_id: &str,
    decision: &str,
    directory: Option<&str>,
) -> Result<Value, String> {
    let normalized = match decision.trim() {
        "allow-session" | "always" | "approved_for_session" => "always",
        "confirm" | "approve" | "approved" | "once" => "once",
        "cancel" | "deny" | "denied" | "reject" | "abort" => "reject",
        other => other,
    };

    let attempts = [
        json!({ "reply": normalized }),
        json!({ "response": normalized, "remember": normalized == "always" }),
        json!({ "response": normalized != "reject", "remember": normalized == "always" }),
    ];

    let mut last_error = None;
    for body in attempts {
        match opencode_request(
            port,
            Method::POST,
            &format!("/permission/{approval_id}/reply"),
            Some(body.clone()),
            directory,
        )
        .await
        {
            Ok(value) => return Ok(value),
            Err(error) => {
                if !error.contains("404") {
                    last_error = Some(error);
                    break;
                }
            }
        }

        if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
            match opencode_request(
                port,
                Method::POST,
                &format!("/session/{session_id}/permissions/{approval_id}"),
                Some(body),
                directory,
            )
            .await
            {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if !error.contains("404") {
                        last_error = Some(error);
                        break;
                    }
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "\u{5f53}\u{524d} OpenCode \u{7248}\u{672c}\u{672a}\u{66b4}\u{9732}\u{53ef}\u{7528}\u{7684}\u{5ba1}\u{6279}\u{56de}\u{590d}\u{63a5}\u{53e3}\u{3002}".to_string()))
}

// ---------------------------------------------------------------------------
// 辅助工具
// ---------------------------------------------------------------------------

pub fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.args(["url.dll,FileProtocolHandler", url]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to open browser: {error}"))?;

    Ok(())
}

pub fn open_auth_window(app: &AppHandle, url: &str) -> Result<(), String> {
    const WINDOW_LABEL: &str = "opencode-auth";

    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.close();
    }

    let parsed = Url::parse(url).map_err(|error| format!("Invalid authorization URL: {error}"))?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .title("Connect Codex")
        .inner_size(520.0, 780.0)
        .center()
        .focused(true)
        .always_on_top(true)
        .on_navigation(|_| true)
        .build()
        .map_err(|error| format!("Failed to open embedded auth window: {error}"))?;

    Ok(())
}

pub fn refresh_child_state(state: &mut OpencodeState) {
    if let Some(child) = state.child.as_mut() {
        if child.try_wait().ok().flatten().is_some() {
            state.child = None;
            state.session_id = None;
            state.managed = false;
        }
    }
}

pub async fn snapshot_opencode(
    app: &AppHandle,
    state: &tauri::State<'_, RuntimeState>,
) -> Result<OpencodeStatus, String> {
    let root = resolve_project_root(app)?;
    let (binary, port, managed, session_id) = {
        let mut opencode = state
            .opencode
            .lock()
            .map_err(|_| "Failed to lock OpenCode state.")?;
        refresh_child_state(&mut opencode);
        (
            opencode.binary.clone(),
            opencode.port,
            opencode.managed,
            opencode.session_id.clone(),
        )
    };
    let resolved_binary = resolve_opencode_binary(app, Some(binary.as_str()));

    let version = opencode_command_version(&resolved_binary, &root).ok();
    let installed = version.is_some();
    let running = opencode_health(port).await;

    Ok(OpencodeStatus {
        installed,
        version,
        running,
        managed,
        binary: resolved_binary.display().to_string(),
        port,
        project_dir: root.display().to_string(),
        session_id,
    })
}

pub fn extract_opencode_error(value: &Value) -> Option<String> {
    read_nested_string(value, &["info", "error", "data", "message"])
        .or_else(|| read_nested_string(value, &["error", "data", "message"]))
        .or_else(|| read_nested_string(value, &["error", "message"]))
}
