// OpenCode 运行时子系统。
// 通过 HTTP API 与本地 OpenCode 进程通信，处理权限审批轮询、
// 会话快照、浏览器授权窗口等。

use crate::types::*;
use crate::utils::*;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::watch;
use tokio::time::sleep;

const OPENCODE_PREFERENCES_RELATIVE_PATH: &str = "runtime/opencode-preferences.json";
const OPENCODE_PROVIDER_SECRETS_RELATIVE_PATH: &str = "runtime/opencode-provider-secrets.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStoredProviderPreference {
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub base_url: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStoredPreferences {
    #[serde(default)]
    pub selected_provider_id: String,
    #[serde(default)]
    pub selected_model_id: String,
    #[serde(default)]
    pub small_model_id: String,
    #[serde(default)]
    pub providers: HashMap<String, OpencodeStoredProviderPreference>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStoredProviderSecret {
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeProviderSecrets {
    #[serde(default)]
    pub providers: HashMap<String, OpencodeStoredProviderSecret>,
}

fn opencode_preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(base.join(OPENCODE_PREFERENCES_RELATIVE_PATH))
}

fn opencode_provider_secrets_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    Ok(base.join(OPENCODE_PROVIDER_SECRETS_RELATIVE_PATH))
}

fn read_json_file<T>(path: &Path) -> Result<T, String>
where
    T: Default + for<'de> Deserialize<'de>,
{
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };

    serde_json::from_str(&content)
        .map_err(|error| format!("Failed to decode {}: {error}", path.display()))
}

fn write_json_file<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to encode {}: {error}", path.display()))?;
    fs::write(path, content).map_err(|error| format!("Failed to write {}: {error}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }

    Ok(())
}

pub fn opencode_preferences_public_value(
    preferences: &OpencodeStoredPreferences,
    secrets: &OpencodeProviderSecrets,
) -> Value {
    let mut providers = serde_json::Map::new();

    for (provider_id, provider_preference) in &preferences.providers {
        let has_api_key = secrets
            .providers
            .get(provider_id)
            .map(|secret| !secret.api_key.trim().is_empty())
            .unwrap_or(false);

        providers.insert(
            provider_id.clone(),
            json!({
                "modelId": provider_preference.model_id,
                "baseUrl": provider_preference.base_url,
                "hasApiKey": has_api_key
            }),
        );
    }

    for (provider_id, provider_secret) in &secrets.providers {
        if providers.contains_key(provider_id) || provider_secret.api_key.trim().is_empty() {
            continue;
        }

        providers.insert(
            provider_id.clone(),
            json!({
                "modelId": "",
                "baseUrl": "",
                "hasApiKey": true
            }),
        );
    }

    json!({
        "selectedProviderId": preferences.selected_provider_id,
        "selectedModelId": preferences.selected_model_id,
        "smallModelId": preferences.small_model_id,
        "providers": providers
    })
}

pub fn load_opencode_preferences(app: &AppHandle) -> Result<OpencodeStoredPreferences, String> {
    read_json_file(&opencode_preferences_path(app)?)
}

pub fn load_opencode_provider_secrets(app: &AppHandle) -> Result<OpencodeProviderSecrets, String> {
    read_json_file(&opencode_provider_secrets_path(app)?)
}

pub fn save_opencode_preferences(
    app: &AppHandle,
    preferences: &OpencodeStoredPreferences,
) -> Result<(), String> {
    write_json_file(&opencode_preferences_path(app)?, preferences)
}

pub fn save_opencode_provider_secrets(
    app: &AppHandle,
    secrets: &OpencodeProviderSecrets,
) -> Result<(), String> {
    write_json_file(&opencode_provider_secrets_path(app)?, secrets)
}

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
// 事件流（会话控制台流式输出）
// ---------------------------------------------------------------------------

/// 从消息列表响应中提取消息数组。
fn extract_opencode_messages(response: &Value) -> Vec<Value> {
    if let Some(array) = response.as_array() {
        return array.clone();
    }

    if response.get("parts").and_then(Value::as_array).is_some() {
        return vec![response.clone()];
    }

    if let Some(message) = response.get("message") {
        if message.is_object() {
            return vec![message.clone()];
        }
    }

    for key in ["messages", "items", "data"] {
        if let Some(value) = response.get(key) {
            if let Some(array) = value.as_array() {
                return array.clone();
            }
            if let Some(array) = value.get("messages").and_then(Value::as_array) {
                return array.clone();
            }
            if let Some(message) = value.get("message") {
                if message.is_object() {
                    return vec![message.clone()];
                }
            }
            if value.get("parts").and_then(Value::as_array).is_some() {
                return vec![value.clone()];
            }
        }
    }
    Vec::new()
}

fn opencode_message_parts(message: &Value) -> Vec<Value> {
    if let Some(array) = message.get("parts").and_then(Value::as_array) {
        return array.clone();
    }
    if let Some(array) = message.get("content").and_then(Value::as_array) {
        return array.clone();
    }
    Vec::new()
}

fn opencode_part_id(part: &Value) -> String {
    read_nested_string(part, &["id"])
        .or_else(|| read_nested_string(part, &["partID"]))
        .or_else(|| read_nested_string(part, &["partId"]))
        .or_else(|| read_nested_string(part, &["toolCallId"]))
        .or_else(|| read_nested_string(part, &["tool_call_id"]))
        .unwrap_or_else(|| "unknown".to_string())
}

fn emit_opencode_message_part_internal(
    app: &AppHandle,
    stream_id: &str,
    part: &Value,
    suppress_log_line: bool,
    visible_log_counter: Option<&Arc<AtomicUsize>>,
) {
    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
    let part_id = opencode_part_id(part);
    let emit = |value: Value| {
        if !suppress_log_line {
            if let Some(counter) = visible_log_counter {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
        emit_cli_stream_json_event(app, "opencode", stream_id, &value);
    };

    match part_type {
        "text" => {
            let text = part
                .get("text")
                .or_else(|| part.get("content"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                return;
            }
            emit(json!({
                "type": "designcode.block",
                "block": {
                    "id": format!("opencode-text-{part_id}"),
                    "type": "text",
                    "content": text,
                    "backend": "opencode",
                    "suppressLogLine": suppress_log_line
                }
            }));
        }
        "tool" | "tool-invocation" | "tool-call" | "tool_call" => {
            let tool_name = part
                .get("toolName")
                .or_else(|| part.get("name"))
                .or_else(|| part.get("tool"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let tool_name_normalized = tool_name.to_ascii_lowercase();
            let state = part.get("state");
            let args = state
                .and_then(|value| value.get("input"))
                .or_else(|| part.get("args"))
                .or_else(|| part.get("input"));
            let command = args
                .and_then(|a| {
                    a.get("command")
                        .or_else(|| a.get("cmd"))
                        .or_else(|| a.get("commandLine"))
                })
                .and_then(Value::as_str);
            let file_path = args.and_then(|a| {
                a.get("filePath")
                    .or_else(|| a.get("file_path"))
                    .or_else(|| a.get("path"))
                    .and_then(Value::as_str)
            });
            let detail = args
                .and_then(|a| {
                    a.get("pattern")
                        .or_else(|| a.get("query"))
                        .or_else(|| a.get("url"))
                        .or_else(|| a.get("task"))
                })
                .and_then(Value::as_str);
            let result = state
                .and_then(|value| value.get("output"))
                .or_else(|| part.get("result"))
                .and_then(Value::as_str);
            let error = state
                .and_then(|value| value.get("error"))
                .and_then(Value::as_str);
            let status = state
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    if error.is_some() {
                        "error"
                    } else if result.is_some() {
                        "completed"
                    } else {
                        "running"
                    }
                });
            let tool_id = part_id.as_str();

            if command.is_some()
                || tool_name.eq_ignore_ascii_case("bash")
                || tool_name.eq_ignore_ascii_case("shell")
            {
                emit(json!({
                    "type": "designcode.block",
                    "block": {
                        "id": format!("opencode-cmd-{tool_id}"),
                        "type": "command",
                        "command": command.unwrap_or(tool_name),
                        "output": error.unwrap_or(result.unwrap_or("")),
                        "status": if status == "completed" { "success" } else { status },
                        "backend": "opencode",
                        "suppressLogLine": suppress_log_line
                    }
                }));
                return;
            }

            if file_path.is_some()
                || tool_name_normalized.contains("file")
                || tool_name_normalized.contains("write")
                || tool_name_normalized.contains("read")
                || tool_name_normalized.contains("edit")
            {
                emit(json!({
                    "type": "opencode.file",
                    "id": format!("opencode-file-{tool_id}"),
                    "tool": tool_name,
                    "path": file_path.unwrap_or(""),
                    "detail": detail,
                    "message": error,
                    "status": status,
                    "suppressLogLine": suppress_log_line
                }));
                return;
            }

            emit(json!({
                "type": "opencode.tool",
                "id": format!("opencode-tool-{tool_id}"),
                "tool": tool_name,
                "detail": detail,
                "message": error,
                "status": status,
                "suppressLogLine": suppress_log_line
            }));
        }
        "patch" => {
            let files = part
                .get("files")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            if files.is_empty() {
                emit(json!({
                    "type": "opencode.tool",
                    "id": format!("opencode-patch-{part_id}"),
                    "tool": "patch",
                    "status": "completed",
                    "suppressLogLine": suppress_log_line
                }));
                return;
            }

            for (index, file) in files.iter().enumerate() {
                let Some(path) = file.as_str() else {
                    continue;
                };
                emit(json!({
                    "type": "opencode.file",
                    "id": format!("opencode-patch-{part_id}-{index}"),
                    "tool": "patch",
                    "path": path,
                    "status": "completed",
                    "suppressLogLine": suppress_log_line
                }));
            }
        }
        "tool-result" | "tool_result" => {
            // 工具结果通常已合并到 tool-invocation 中
        }
        "reasoning" | "thinking" => {
            let content = part
                .get("text")
                .or_else(|| part.get("content"))
                .or_else(|| part.get("thinking"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if !content.is_empty() {
                emit(json!({
                    "type": "designcode.block",
                    "block": {
                        "id": format!("opencode-thought-{part_id}"),
                        "type": "thought",
                        "content": content,
                        "backend": "opencode",
                        "suppressLogLine": suppress_log_line
                    }
                }));
            }
        }
        "step-start" | "step_start" => {
            emit(json!({
                "type": "opencode.status",
                "id": format!("opencode-status-{part_id}"),
                "message": "Thinking...",
                "suppressLogLine": suppress_log_line
            }));
        }
        _ => {}
    }
}

pub fn emit_opencode_message_snapshot_internal(
    app: &AppHandle,
    stream_id: &str,
    response: &Value,
    suppress_log_line: bool,
) -> usize {
    let mut emitted = 0usize;

    for message in extract_opencode_messages(response) {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if !role.is_empty() && role != "assistant" {
            continue;
        }

        for part in opencode_message_parts(&message) {
            emit_opencode_message_part_internal(app, stream_id, &part, suppress_log_line, None);
            emitted += 1;
        }
    }

    emitted
}

/// 解析单个 SSE 事件块并发射对应的 CLI 流事件。
fn process_sse_block(
    app: &AppHandle,
    stream_id: &str,
    block: &str,
    visible_log_counter: &Arc<AtomicUsize>,
) {
    let mut data_lines: Vec<&str> = Vec::new();
    let mut event_name = String::new();

    for line in block.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(':') || trimmed.is_empty() {
            continue;
        }
        if let Some(event) = trimmed.strip_prefix("event:") {
            event_name = event.trim().to_string();
            continue;
        }
        if let Some(data) = trimmed.strip_prefix("data:") {
            data_lines.push(data.trim());
        }
    }

    if data_lines.is_empty() {
        return;
    }

    let data_str = data_lines.join("\n");
    let Ok(mut json) = serde_json::from_str::<Value>(&data_str) else {
        return;
    };

    if !event_name.is_empty() && json.get("type").is_none() {
        if let Some(object) = json.as_object_mut() {
            object.insert("type".to_string(), Value::String(event_name));
        }
    }

    emit_opencode_sse_json(app, stream_id, &json, visible_log_counter);
}

/// 处理解析后的 SSE JSON 事件。
fn emit_opencode_sse_json(
    app: &AppHandle,
    stream_id: &str,
    json: &Value,
    visible_log_counter: &Arc<AtomicUsize>,
) {
    let event_type = json.get("type").and_then(Value::as_str).unwrap_or("");
    let properties = json
        .get("properties")
        .cloned()
        .unwrap_or_else(|| json.clone());
    let emit = |value: Value| {
        visible_log_counter.fetch_add(1, Ordering::Relaxed);
        emit_cli_stream_json_event(app, "opencode", stream_id, &value);
    };

    match event_type {
        "part.updated" | "message.part.delta" | "message.part.start" | "message.part.stop" => {
            if let Some(part) = properties.get("part").or(Some(&properties)) {
                emit_opencode_message_part_internal(
                    app,
                    stream_id,
                    part,
                    false,
                    Some(visible_log_counter),
                );
            }
        }
        "message.updated" | "message.created" => {
            if let Some(message) = properties.get("message").or(Some(&properties)) {
                let role = message.get("role").and_then(Value::as_str).unwrap_or("");
                if role.is_empty() || role == "assistant" {
                    for part in opencode_message_parts(message) {
                        emit_opencode_message_part_internal(
                            app,
                            stream_id,
                            &part,
                            false,
                            Some(visible_log_counter),
                        );
                    }
                }
            }
        }
        "message.start" => {
            emit(json!({ "type": "opencode.status", "message": "\u{6b63}\u{5728}\u{5904}\u{7406}..." }));
        }
        "error" => {
            let message = read_nested_string(&properties, &["message"])
                .or_else(|| read_nested_string(&properties, &["error"]))
                .unwrap_or_else(|| "Unknown error".to_string());
            emit(json!({ "type": "opencode.error", "message": message }));
        }
        "tool.start" | "tool.end" | "step.start" | "step.end" => {
            let tool = read_nested_string(&properties, &["name"])
                .or_else(|| read_nested_string(&properties, &["tool"]))
                .unwrap_or_default();
            if !tool.is_empty() {
                let event_id = read_nested_string(&properties, &["id"])
                    .or_else(|| read_nested_string(&properties, &["toolCallId"]))
                    .unwrap_or_else(|| format!("{}-{}", event_type.replace('.', "-"), tool));
                let status = if event_type.ends_with(".start") {
                    "running"
                } else {
                    "completed"
                };
                emit(json!({
                    "type": "opencode.tool",
                    "id": event_id,
                    "tool": tool,
                    "status": status
                }));
            }
        }
        "event" => {
            if let Some(nested_type) = read_nested_string(&properties, &["type"]) {
                let mut nested = properties.clone();
                if let Some(obj) = nested.as_object_mut() {
                    obj.insert("type".to_string(), Value::String(nested_type));
                }
                emit_opencode_sse_json(app, stream_id, &nested, visible_log_counter);
            }
        }
        _ => {
            if let Some(part) = properties.get("part") {
                emit_opencode_message_part_internal(
                    app,
                    stream_id,
                    part,
                    false,
                    Some(visible_log_counter),
                );
            }
        }
    }
}

/// 尝试通过 SSE 端点接收事件流。成功连接返回 `true`。
async fn try_opencode_sse_stream(
    app: &AppHandle,
    port: u16,
    session_id: &str,
    directory: Option<&str>,
    stream_id: &str,
    stop_rx: &watch::Receiver<bool>,
    visible_log_counter: &Arc<AtomicUsize>,
) -> bool {
    let url = format!("http://127.0.0.1:{port}/session/{session_id}/event");
    let client = reqwest::Client::new();
    let mut request = client
        .get(&url)
        .header("Accept", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .timeout(Duration::from_secs(1800));

    if let Some(dir) = directory.filter(|v| !v.trim().is_empty()) {
        request = request.query(&[("directory", dir)]);
    }

    let response = match request.send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.contains("text/event-stream") && !content_type.contains("text/plain") {
        return false;
    }

    let mut response = response;
    let mut buffer = String::new();
    loop {
        if *stop_rx.borrow() {
            break;
        }

        match tokio::time::timeout(Duration::from_secs(2), response.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                if let Ok(text) = std::str::from_utf8(&bytes) {
                    buffer.push_str(text);
                    while let Some(pos) = buffer.find("\n\n") {
                        let event_block = buffer[..pos].to_string();
                        buffer = buffer[pos + 2..].to_string();
                        process_sse_block(app, stream_id, &event_block, visible_log_counter);
                    }
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }

    true
}

/// 轮询消息端点获取增量更新（SSE 不可用时的回退方案）。
async fn poll_opencode_messages_stream(
    app: &AppHandle,
    port: u16,
    session_id: &str,
    directory: Option<&str>,
    stream_id: &str,
    stop_rx: &watch::Receiver<bool>,
    visible_log_counter: &Arc<AtomicUsize>,
) {
    let mut seen_parts: HashMap<String, String> = HashMap::new();
    let sync_messages = |response: &Value, seen_parts: &mut HashMap<String, String>| {
        let messages = extract_opencode_messages(response);
        for (message_index, message) in messages.iter().enumerate() {
            let msg_id = message
                .get("id")
                .or_else(|| message.get("messageID"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if !role.is_empty() && role != "assistant" {
                continue;
            }
            let message_key = if msg_id.is_empty() {
                format!("message-{message_index}")
            } else {
                msg_id.to_string()
            };

            let parts = opencode_message_parts(message);
            for (index, part) in parts.iter().enumerate() {
                let part_id = opencode_part_id(part);
                let signature_id = if part_id == "unknown" {
                    format!("{message_key}:{index}")
                } else {
                    format!("{message_key}:{part_id}")
                };
                let Ok(signature) = serde_json::to_string(part) else {
                    continue;
                };

                match seen_parts.get(&signature_id) {
                    Some(previous) if previous == &signature => {}
                    Some(_) => {
                        emit_opencode_message_part_internal(
                            app,
                            stream_id,
                            part,
                            true,
                            Some(visible_log_counter),
                        );
                        seen_parts.insert(signature_id, signature);
                    }
                    None => {
                        emit_opencode_message_part_internal(
                            app,
                            stream_id,
                            part,
                            false,
                            Some(visible_log_counter),
                        );
                        seen_parts.insert(signature_id, signature);
                    }
                }
            }
        }
    };

    // 初始化已有消息的部件计数，仅追踪后续新增内容
    if let Ok(response) = opencode_request(
        port,
        Method::GET,
        &format!("/session/{session_id}/message"),
        None,
        directory,
    )
    .await
    {
        for (message_index, message) in extract_opencode_messages(&response).iter().enumerate() {
            let msg_id = message
                .get("id")
                .or_else(|| message.get("messageID"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            if !role.is_empty() && role != "assistant" {
                continue;
            }
            let message_key = if msg_id.is_empty() {
                format!("message-{message_index}")
            } else {
                msg_id.to_string()
            };

            for (index, part) in opencode_message_parts(&message).iter().enumerate() {
                let part_id = opencode_part_id(part);
                let signature_id = if part_id == "unknown" {
                    format!("{message_key}:{index}")
                } else {
                    format!("{message_key}:{part_id}")
                };
                if let Ok(signature) = serde_json::to_string(part) {
                    seen_parts.insert(signature_id, signature);
                }
            }
        }
    }

    loop {
        if *stop_rx.borrow() {
            if let Ok(response) = opencode_request(
                port,
                Method::GET,
                &format!("/session/{session_id}/message"),
                None,
                directory,
            )
            .await
            {
                sync_messages(&response, &mut seen_parts);
            }
            break;
        }

        if let Ok(response) = opencode_request(
            port,
            Method::GET,
            &format!("/session/{session_id}/message"),
            None,
            directory,
        )
        .await
        {
            sync_messages(&response, &mut seen_parts);
        }

        // 分段休眠以便及时响应停止信号
        let mut stop_requested = false;
        for _ in 0..5 {
            if *stop_rx.borrow() {
                stop_requested = true;
                break;
            }
            sleep(Duration::from_millis(300)).await;
        }
        if stop_requested {
            continue;
        }
    }
}

/// 启动 OpenCode 会话事件流监听任务。
/// 优先使用 SSE 端点，不可用时回退为消息轮询。
pub fn spawn_opencode_event_stream(
    app: &AppHandle,
    port: u16,
    session_id: &str,
    directory: Option<&str>,
    stream_id: &str,
) -> (
    watch::Sender<bool>,
    tokio::task::JoinHandle<()>,
    Arc<AtomicUsize>,
) {
    let app = app.clone();
    let session_id = session_id.to_string();
    let directory = directory.map(ToOwned::to_owned);
    let stream_id = stream_id.to_string();
    let visible_log_counter = Arc::new(AtomicUsize::new(0));
    let (stop_tx, stop_rx) = watch::channel(false);
    let visible_log_counter_for_task = visible_log_counter.clone();

    let handle = tokio::spawn(async move {
        let sse_ok = try_opencode_sse_stream(
            &app,
            port,
            &session_id,
            directory.as_deref(),
            &stream_id,
            &stop_rx,
            &visible_log_counter_for_task,
        )
        .await;

        if !sse_ok && !*stop_rx.borrow() {
            poll_opencode_messages_stream(
                &app,
                port,
                &session_id,
                directory.as_deref(),
                &stream_id,
                &stop_rx,
                &visible_log_counter_for_task,
            )
            .await;
        }
    });

    (stop_tx, handle, visible_log_counter)
}

pub async fn emit_opencode_session_snapshot_internal(
    app: &AppHandle,
    port: u16,
    session_id: &str,
    directory: Option<&str>,
    stream_id: &str,
    suppress_log_line: bool,
) -> usize {
    match opencode_request(
        port,
        Method::GET,
        &format!("/session/{session_id}/message"),
        None,
        directory,
    )
    .await
    {
        Ok(response) => {
            emit_opencode_message_snapshot_internal(app, stream_id, &response, suppress_log_line)
        }
        Err(_) => 0,
    }
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
    run_id: &str,
) -> Result<OpencodeStatus, String> {
    let root = resolve_project_root(app)?;
    let (binary, port, managed, session_id) = with_opencode_state(state.inner(), run_id, |opencode| {
        refresh_child_state(opencode);
        (
            opencode.binary.clone(),
            opencode.port,
            opencode.managed,
            opencode.session_id.clone(),
        )
    })?;
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
