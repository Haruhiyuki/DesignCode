// 在 release 构建中隐藏 Windows 控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// DesignCode Desktop — Tauri 应用入口
//
// 设计工作流编排、tauri command 处理器、应用初始化。
// 业务逻辑拆分到同级模块：codex / claude / gemini / opencode / utils / types / menu。

mod types;
mod menu;
mod utils;
mod codex;
mod claude;
mod gemini;
mod opencode;
use types::*;
use utils::*;
use codex::*;
use claude::*;
use gemini::*;
use opencode::*;

use reqwest::Method;
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// 设计工作流 — 负责 prepare → 调度后端 → sync 的完整流程
// ---------------------------------------------------------------------------

fn compose_codex_design_prompt(system_prompt: &str, user_message: &str) -> String {
    [
        compose_design_system_prompt(system_prompt).as_str(),
        "",
        "[User Request]",
        user_message,
    ]
    .join("\n")
}

fn compact_single_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_text(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let mut output = String::new();

    for _ in 0..limit {
        match chars.next() {
            Some(ch) => output.push(ch),
            None => return output,
        }
    }

    if chars.next().is_some() && !output.is_empty() {
        output.pop();
        output.push('\u{2026}');
    }

    output
}

fn looks_like_source_dump(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    if trimmed.contains("```html")
        || trimmed.contains("```css")
        || trimmed.contains("```svg")
        || trimmed.contains("```xml")
        || trimmed.contains("<!DOCTYPE html")
        || trimmed.contains("</html>")
        || trimmed.contains("<style")
        || trimmed.contains("<svg")
    {
        return true;
    }

    trimmed.len() > 900 && trimmed.matches('<').count() >= 8
}

fn sanitize_design_agent_summary(summary: &str, fallback: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    let before_fence = trimmed.split("```").next().unwrap_or("").trim();
    if looks_like_source_dump(trimmed) {
        if !before_fence.is_empty() && !looks_like_source_dump(before_fence) {
            return truncate_text(&compact_single_line(before_fence), 240);
        }
        return fallback.to_string();
    }

    let compact = compact_single_line(trimmed);
    if compact.is_empty() {
        fallback.to_string()
    } else {
        truncate_text(&compact, 240)
    }
}



fn extract_session_id(value: &Value) -> Option<String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| value.get("sessionID").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("session")
                .and_then(|session| session.get("id"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
}

fn extract_prompt_bundle_fields(prepared: &Value) -> Result<(Value, String, String), String> {
    let bundle = prepared
        .get("promptBundle")
        .cloned()
        .ok_or_else(|| "Missing promptBundle from design preparation.".to_string())?;
    let system_prompt = bundle
        .get("systemPrompt")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Missing systemPrompt from design preparation.".to_string())?;
    let user_message = bundle
        .get("userMessage")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| "Missing userMessage from design preparation.".to_string())?;

    Ok((bundle, system_prompt, user_message))
}

fn compose_design_system_prompt(base_prompt: &str) -> String {
    base_prompt.trim().to_string()
}


async fn ensure_opencode_ready(
    app: &AppHandle,
    state: &State<'_, RuntimeState>,
    run_id: &str,
) -> Result<OpencodeStatus, String> {
    let status = snapshot_opencode(app, state, run_id).await?;
    if status.running {
        return Ok(status);
    }

    if !status.installed {
        return Err(
            "OpenCode runtime is unavailable. Prepare the bundled desktop runtime or provide a custom executable path."
                .to_string(),
        );
    }

    opencode_start(
        app.clone(),
        state.clone(),
        run_id.to_string(),
        Some(status.binary.clone()),
        None,
        Some(status.port),
    )
    .await
}

async fn ensure_design_session(
    app: &AppHandle,
    state: &State<'_, RuntimeState>,
    run_id: &str,
    design: &Value,
) -> Result<String, String> {
    if let Some(session_id) = read_nested_string(design, &["runtimeSessions", "opencode"])
        .or_else(|| read_nested_string(design, &["sessionId"]))
    {
        return Ok(session_id);
    }

    let design_id = read_nested_string(design, &["id"])
        .ok_or_else(|| "Missing design id in prepared session.".to_string())?;
    let workspace_dir = read_nested_string(design, &["workspaceDir"])
        .ok_or_else(|| "Missing workspace directory in prepared session.".to_string())?;
    let status = snapshot_opencode(app, state, run_id).await?;
    let response = opencode_request(
        status.port,
        Method::POST,
        "/session",
        Some(json!({
            "title": format!("DesignCode {design_id}")
        })),
        Some(workspace_dir.as_str()),
    )
    .await?;
    let session_id = extract_session_id(&response)
        .ok_or_else(|| "OpenCode did not return a session id.".to_string())?;

    run_node_bridge(
        app,
        "design-attach-session",
        Some(json!({
            "designId": design_id,
            "sessionId": session_id,
            "runtimeBackend": "opencode"
        })),
    )?;

    with_opencode_state(state.inner(), run_id, |opencode| {
        opencode.session_id = Some(session_id.clone());
    })?;

    Ok(session_id)
}

fn summarize_design_mode_for_backend(mode: &str, backend: &str) -> String {
    match (backend, mode) {
        ("codex", "generate") => "Initial render completed via Codex.".to_string(),
        ("codex", "edit") => "Render updated successfully via Codex.".to_string(),
        ("codex", _) => "Codex workspace updated.".to_string(),
        ("claude", "generate") => "Initial render completed via Claude Code.".to_string(),
        ("claude", "edit") => "Render updated successfully via Claude Code.".to_string(),
        ("claude", _) => "Claude Code workspace updated.".to_string(),
        ("gemini", "generate") => "Initial render completed via Gemini CLI.".to_string(),
        ("gemini", "edit") => "Render updated successfully via Gemini CLI.".to_string(),
        ("gemini", _) => "Gemini CLI workspace updated.".to_string(),
        (_, "generate") => "Initial render completed via OpenCode.".to_string(),
        (_, "edit") => "Render updated successfully via OpenCode.".to_string(),
        _ => "OpenCode workspace updated.".to_string(),
    }
}

fn summarize_design_mode(mode: &str) -> String {
    summarize_design_mode_for_backend(mode, "opencode")
}

async fn run_opencode_design(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: &str,
    payload: Value,
    mode: &str,
) -> Result<Value, String> {
    let mut prepare_payload = payload.clone();
    if let Some(object) = prepare_payload.as_object_mut() {
        object.insert("mode".to_string(), Value::String(mode.to_string()));
    }

    let prepared = run_node_bridge(&app, "design-prepare", Some(prepare_payload))?;
    let design = prepared
        .get("design")
        .cloned()
        .ok_or_else(|| "Missing design payload from preparation.".to_string())?;
    let design_id = read_nested_string(&design, &["id"])
        .ok_or_else(|| "Missing design id from preparation.".to_string())?;
    let workspace_dir = read_nested_string(&design, &["workspaceDir"])
        .ok_or_else(|| "Missing workspace directory from preparation.".to_string())?;
    let session_id = ensure_design_session(&app, &state, run_id, &design).await?;
    let status = ensure_opencode_ready(&app, &state, run_id).await?;
    let (prompt_bundle, system_prompt, user_message) = extract_prompt_bundle_fields(&prepared)?;
    let stream_id = payload
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned);

    let poller = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_permission_poller(
                &app,
                status.port,
                session_id.as_str(),
                Some(workspace_dir.as_str()),
                stream_id,
            )
        });

    let event_stream = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_event_stream(
                &app,
                status.port,
                session_id.as_str(),
                Some(workspace_dir.as_str()),
                stream_id,
            )
        });

    let response = opencode_request_with_timeout(
        status.port,
        Method::POST,
        &format!("/session/{session_id}/message"),
        Some(json!({
            "parts": [
                {
                    "type": "text",
                    "text": user_message
                }
            ],
            "agent": "build",
            "system": compose_design_system_prompt(&system_prompt)
        })),
        Some(workspace_dir.as_str()),
        Duration::from_secs(1800),
    )
    .await;

    let mut visible_opencode_log_events = 0usize;
    if let Some((stop_tx, handle, counter)) = event_stream {
        let _ = stop_tx.send(true);
        let _ = handle.await;
        visible_opencode_log_events = counter.load(std::sync::atomic::Ordering::Relaxed);
    }
    if let Some((stop_tx, handle)) = poller {
        let _ = stop_tx.send(true);
        let _ = handle.await;
    }

    let response = response?;

    if let Some(stream_id) = stream_id.as_deref() {
        if visible_opencode_log_events == 0 {
            let _ = emit_opencode_session_snapshot_internal(
                &app,
                status.port,
                session_id.as_str(),
                Some(workspace_dir.as_str()),
                stream_id,
                false,
            )
            .await;
        } else {
            let emitted = emit_opencode_message_snapshot_internal(&app, stream_id, &response, true);
            if emitted == 0 {
                let _ = emit_opencode_session_snapshot_internal(
                    &app,
                    status.port,
                    session_id.as_str(),
                    Some(workspace_dir.as_str()),
                    stream_id,
                    true,
                )
                .await;
            }
        }
    }

    if let Some(error) = extract_opencode_error(&response) {
        return Err(format!("OpenCode design execution failed: {error}"));
    }

    let mut sync_payload = payload;
    if let Some(object) = sync_payload.as_object_mut() {
        object.insert("designId".to_string(), Value::String(design_id));
        object.insert("sessionId".to_string(), Value::String(session_id.clone()));
        object.insert("runtimeBackend".to_string(), Value::String("opencode".to_string()));
        object.insert("mode".to_string(), Value::String(mode.to_string()));
        object.insert("summary".to_string(), Value::String(summarize_design_mode(mode)));
        object.insert("promptBundle".to_string(), prompt_bundle);
        if let Some(meta) = prepared.get("meta") {
            object.insert("meta".to_string(), meta.clone());
        }
        if let Some(config_signature) = design.get("configSignature") {
            object.insert("configSignature".to_string(), config_signature.clone());
        }
    }

    let mut synced = run_node_bridge(&app, "design-sync-workspace", Some(sync_payload))?;
    let needs_session_patch = synced
        .get("design")
        .and_then(|design| design.get("sessionId"))
        .and_then(Value::as_str)
        .map(|value| value.is_empty())
        .unwrap_or(true);

    if needs_session_patch {
        let design_id = read_nested_string(&synced, &["design", "id"]).unwrap_or_default();
        run_node_bridge(
            &app,
            "design-attach-session",
            Some(json!({
                "designId": design_id,
                "sessionId": session_id,
                "runtimeBackend": "opencode"
            })),
        )?;
        if let Some(design) = synced.get_mut("design").and_then(Value::as_object_mut) {
            design.insert(
                "sessionId".to_string(),
                Value::String(session_id.clone()),
            );
            if let Some(sessions) = design
                .entry("runtimeSessions")
                .or_insert_with(|| json!({}))
                .as_object_mut()
            {
                sessions.insert("opencode".to_string(), Value::String(session_id.clone()));
            }
        }
    }

    if let Some(object) = synced.as_object_mut() {
        object.insert("provider".to_string(), Value::String("opencode".to_string()));
    }

    Ok(synced)
}

async fn run_codex_design(
    app: AppHandle,
    run_id: String,
    payload: Value,
    mode: &str,
) -> Result<Value, String> {
    let mut prepare_payload = payload.clone();
    if let Some(object) = prepare_payload.as_object_mut() {
        object.insert("mode".to_string(), Value::String(mode.to_string()));
        object.insert("runtimeBackend".to_string(), Value::String("codex".to_string()));
    }

    let prepared = run_node_bridge(&app, "design-prepare", Some(prepare_payload))?;
    let design = prepared
        .get("design")
        .cloned()
        .ok_or_else(|| "Missing design payload from preparation.".to_string())?;
    let design_id = read_nested_string(&design, &["id"])
        .ok_or_else(|| "Missing design id from preparation.".to_string())?;
    let workspace_dir = read_nested_string(&design, &["workspaceDir"])
        .ok_or_else(|| "Missing workspace directory from preparation.".to_string())?;
    let existing_thread_id = read_nested_string(&design, &["runtimeSessions", "codex"]);
    let (_, system_prompt, user_message) = extract_prompt_bundle_fields(&prepared)?;
    let prompt_bundle = prepared
        .get("promptBundle")
        .cloned()
        .ok_or_else(|| "Missing promptBundle from design preparation.".to_string())?;
    let model = payload
        .get("runtimeModel")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let reasoning_effort = payload
        .get("runtimeReasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let codex_binary = payload
        .get("codexBinary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let runtime_proxy = payload
        .get("runtimeProxy")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let stream_id = payload
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let handle = app.clone();
    let workspace_dir_for_turn = workspace_dir.clone();
    let existing_thread_for_turn = existing_thread_id.clone();
    let system_prompt_for_turn = system_prompt.clone();
    let user_message_for_turn = user_message.clone();
    let model_for_turn = model.map(ToOwned::to_owned);
    let effort_for_turn = reasoning_effort.map(ToOwned::to_owned);
    let binary_for_turn = codex_binary.map(ToOwned::to_owned);
    let proxy_for_turn = runtime_proxy.map(ToOwned::to_owned);
    let stream_id_for_turn = stream_id.map(ToOwned::to_owned);
    let run_id_for_turn = run_id.clone();
    let join = tokio::task::spawn_blocking(move || {
        let runtime = handle.state::<RuntimeState>();
        run_codex_app_server_turn(
            &handle,
            runtime.inner(),
            run_id_for_turn.as_str(),
            &workspace_dir_for_turn,
            existing_thread_for_turn.as_deref(),
            Some(system_prompt_for_turn.as_str()),
            &user_message_for_turn,
            model_for_turn.as_deref(),
            effort_for_turn.as_deref(),
            binary_for_turn.as_deref(),
            proxy_for_turn.as_deref(),
            stream_id_for_turn.as_deref(),
        )
    });
    let (thread_id, summary) = join
        .await
        .map_err(|error| format!("Codex App Server task failed to join: {error}"))??;
    let fallback_summary = summarize_design_mode_for_backend(mode, "codex");
    let safe_summary = sanitize_design_agent_summary(&summary, &fallback_summary);

    let mut sync_payload = payload;
    if let Some(object) = sync_payload.as_object_mut() {
        object.insert("designId".to_string(), Value::String(design_id.clone()));
        object.insert("sessionId".to_string(), Value::String(thread_id.clone()));
        object.insert("runtimeBackend".to_string(), Value::String("codex".to_string()));
        object.insert("mode".to_string(), Value::String(mode.to_string()));
        object.insert(
            "summary".to_string(),
            Value::String(safe_summary),
        );
        object.insert("promptBundle".to_string(), prompt_bundle);
        if let Some(meta) = prepared.get("meta") {
            object.insert("meta".to_string(), meta.clone());
        }
        if let Some(config_signature) = design.get("configSignature") {
            object.insert("configSignature".to_string(), config_signature.clone());
        }
    }

    let mut synced = run_node_bridge(&app, "design-sync-workspace", Some(sync_payload))?;
    let needs_thread_patch = synced
        .get("design")
        .and_then(|design| design.get("runtimeSessions"))
        .and_then(|sessions| sessions.get("codex"))
        .and_then(Value::as_str)
        .map(|value| value.is_empty())
        .unwrap_or(true);

    if needs_thread_patch {
        run_node_bridge(
            &app,
            "design-attach-session",
            Some(json!({
                "designId": design_id,
                "sessionId": thread_id,
                "runtimeBackend": "codex"
            })),
        )?;
    }

    if let Some(object) = synced.as_object_mut() {
        object.insert("provider".to_string(), Value::String("codex".to_string()));
    }

    Ok(synced)
}

async fn run_cli_design(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: &str,
    payload: Value,
    mode: &str,
    backend: &str,
) -> Result<Value, String> {
    let mut prepare_payload = payload.clone();
    if let Some(object) = prepare_payload.as_object_mut() {
        object.insert("mode".to_string(), Value::String(mode.to_string()));
        object.insert("runtimeBackend".to_string(), Value::String(backend.to_string()));
    }

    let prepared = run_node_bridge(&app, "design-prepare", Some(prepare_payload))?;
    let design = prepared
        .get("design")
        .cloned()
        .ok_or_else(|| "Missing design payload from preparation.".to_string())?;
    let design_id = read_nested_string(&design, &["id"])
        .ok_or_else(|| "Missing design id from preparation.".to_string())?;
    let workspace_dir = read_nested_string(&design, &["workspaceDir"])
        .ok_or_else(|| "Missing workspace directory from preparation.".to_string())?;
    let existing_session_id = design
        .get("runtimeSessions")
        .and_then(|sessions| sessions.get(backend))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let (_, system_prompt, user_message) = extract_prompt_bundle_fields(&prepared)?;
    let prompt_bundle = prepared
        .get("promptBundle")
        .cloned()
        .ok_or_else(|| "Missing promptBundle from design preparation.".to_string())?;
    let model = payload
        .get("runtimeModel")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let reasoning_effort = payload
        .get("runtimeReasoningEffort")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let runtime_binary = payload
        .get("runtimeBinary")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let runtime_proxy = payload
        .get("runtimeProxy")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let stream_id = payload
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let prompt = compose_codex_design_prompt(&system_prompt, &user_message);

    let (session_id, summary) = match backend {
        "claude" => run_claude_stream_turn(
            &app,
            state.inner(),
            run_id,
            &prompt,
            &workspace_dir,
            existing_session_id.as_deref(),
            model,
            reasoning_effort,
            runtime_binary,
            runtime_proxy,
            stream_id,
        )?,
        "gemini" => run_gemini_exec(
            &app,
            state.inner(),
            &prompt,
            &workspace_dir,
            existing_session_id.as_deref(),
            model,
            runtime_binary,
            runtime_proxy,
            stream_id,
        )?,
        _ => return Err(format!("Unsupported CLI backend: {backend}")),
    };
    let fallback_summary = summarize_design_mode_for_backend(mode, backend);
    let safe_summary = sanitize_design_agent_summary(&summary, &fallback_summary);

    let mut sync_payload = payload;
    if let Some(object) = sync_payload.as_object_mut() {
        object.insert("designId".to_string(), Value::String(design_id.clone()));
        object.insert("runtimeBackend".to_string(), Value::String(backend.to_string()));
        object.insert("mode".to_string(), Value::String(mode.to_string()));
        object.insert(
            "summary".to_string(),
            Value::String(safe_summary),
        );
        object.insert("promptBundle".to_string(), prompt_bundle);
        if let Some(session_id) = session_id.as_ref() {
            object.insert("sessionId".to_string(), Value::String(session_id.clone()));
        }
        if let Some(meta) = prepared.get("meta") {
            object.insert("meta".to_string(), meta.clone());
        }
        if let Some(config_signature) = design.get("configSignature") {
            object.insert("configSignature".to_string(), config_signature.clone());
        }
    }

    let mut synced = run_node_bridge(&app, "design-sync-workspace", Some(sync_payload))?;
    let needs_patch = synced
        .get("design")
        .and_then(|design| design.get("runtimeSessions"))
        .and_then(|sessions| sessions.get(backend))
        .and_then(Value::as_str)
        .map(|value| value.is_empty())
        .unwrap_or(true);

    if needs_patch {
        if let Some(session_id) = session_id.as_ref() {
            run_node_bridge(
                &app,
                "design-attach-session",
                Some(json!({
                    "designId": design_id,
                    "sessionId": session_id,
                    "runtimeBackend": backend
                })),
            )?;
        }
    }

    if let Some(object) = synced.as_object_mut() {
        object.insert("provider".to_string(), Value::String(backend.to_string()));
    }

    Ok(synced)
}

fn runtime_backend_from_payload(payload: &Value) -> &str {
    payload
        .get("runtimeBackend")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("opencode")
}

// ---------------------------------------------------------------------------
// Tauri command 处理器 — 前端通过 invoke() 调用的所有入口
// ---------------------------------------------------------------------------

#[tauri::command]
fn desktop_catalog(app: AppHandle) -> Result<Value, String> {
    run_node_bridge(&app, "catalog", None)
}

#[tauri::command]
async fn desktop_generate_design(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    payload: Value,
) -> Result<Value, String> {
    match runtime_backend_from_payload(&payload) {
        "codex" => run_codex_design(app, run_id, payload, "generate").await,
        "claude" => run_cli_design(app, state, run_id.as_str(), payload, "generate", "claude").await,
        "gemini" => run_cli_design(app, state, run_id.as_str(), payload, "generate", "gemini").await,
        _ => run_opencode_design(app, state, run_id.as_str(), payload, "generate").await,
    }
}

#[tauri::command]
async fn desktop_edit_design(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    payload: Value,
) -> Result<Value, String> {
    match runtime_backend_from_payload(&payload) {
        "codex" => run_codex_design(app, run_id, payload, "edit").await,
        "claude" => run_cli_design(app, state, run_id.as_str(), payload, "edit", "claude").await,
        "gemini" => run_cli_design(app, state, run_id.as_str(), payload, "edit", "gemini").await,
        _ => run_opencode_design(app, state, run_id.as_str(), payload, "edit").await,
    }
}

#[tauri::command]
fn desktop_designs_list(app: AppHandle) -> Result<Value, String> {
    run_node_bridge(&app, "design-list", None)
}

#[tauri::command]
fn desktop_design_create(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "design-create", Some(payload))
}

#[tauri::command]
fn desktop_art_assets_list(app: AppHandle) -> Result<Value, String> {
    run_node_bridge(&app, "art-assets-list", None)
}

#[tauri::command]
fn desktop_art_asset_import(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "art-asset-import", Some(payload))
}

#[tauri::command]
fn desktop_art_asset_import_paths(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "art-asset-import-paths", Some(payload))
}

#[tauri::command]
fn desktop_art_asset_update(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "art-asset-update", Some(payload))
}

#[tauri::command]
fn desktop_art_asset_delete(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "art-asset-delete", Some(payload))
}

#[tauri::command]
fn desktop_art_asset_preview(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "art-asset-preview", Some(payload))
}

#[tauri::command]
fn desktop_design_open(app: AppHandle, design_id: String) -> Result<Value, String> {
    run_node_bridge(&app, "design-open", Some(json!({ "designId": design_id })))
}

#[tauri::command]
fn desktop_design_delete(app: AppHandle, design_id: String) -> Result<Value, String> {
    run_node_bridge(&app, "design-delete", Some(json!({ "designId": design_id })))
}

#[tauri::command]
async fn desktop_design_update(
    app: AppHandle,
    design_id: String,
    payload: Value,
) -> Result<Value, String> {
    let merged = if let Some(object) = payload.as_object() {
        let mut map = object.clone();
        map.insert("designId".to_string(), Value::String(design_id));
        Value::Object(map)
    } else {
        json!({ "designId": design_id, "payload": payload })
    };

    // 素材勾选 / 字段编辑走的都是这条保存路径，自动保存高频触发；同步 command
    // 会在主线程阻塞到 Node 子进程返回，直接拖住 WebView。
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_node_bridge(&handle, "design-update", Some(merged))
    });
    join.await
        .map_err(|error| format!("Design update task failed to join: {error}"))?
}

#[tauri::command]
async fn desktop_design_update_html(app: AppHandle, payload: Value) -> Result<Value, String> {
    // 同步 command 会在主 UI 线程上执行，而 run_node_bridge 要 spawn Node 子进程
    // 并阻塞等待其结束（几百 ms 级），直接锁住 WebView。自动保存对用户应当无感，
    // 所以放到 blocking 线程池里，避免每次静默保存都引发一下可见的卡顿。
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_node_bridge(&handle, "design-update-html", Some(payload))
    });
    join.await
        .map_err(|error| format!("Design update HTML task failed to join: {error}"))?
}

#[tauri::command]
fn desktop_design_commit_read(
    app: AppHandle,
    design_id: String,
    commit_hash: String,
) -> Result<Value, String> {
    run_node_bridge(
        &app,
        "design-commit-read",
        Some(json!({
            "designId": design_id,
            "commitHash": commit_hash
        })),
    )
}

#[tauri::command]
fn desktop_design_attach_session(
    app: AppHandle,
    design_id: String,
    session_id: String,
    runtime_backend: Option<String>,
) -> Result<Value, String> {
    run_node_bridge(
        &app,
        "design-attach-session",
        Some(json!({
            "designId": design_id,
            "sessionId": session_id,
            "runtimeBackend": runtime_backend
        })),
    )
}

#[tauri::command]
fn desktop_design_sync_workspace(app: AppHandle, payload: Value) -> Result<Value, String> {
    run_node_bridge(&app, "design-sync-workspace", Some(payload))
}

#[tauri::command]
async fn desktop_context(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
) -> Result<DesktopContext, String> {
    let root = resolve_project_root(&app)?;
    let node_version = command_version(resolve_node_binary(&app), "--version", &root);
    let opencode = snapshot_opencode(&app, &state, run_id.as_str()).await?;

    Ok(DesktopContext {
        is_desktop: true,
        node_available: node_version.is_some(),
        node_version,
        opencode_available: opencode.installed,
        opencode_version: opencode.version,
        opencode_running: opencode.running,
        opencode_port: opencode.port,
        project_dir: root.display().to_string(),
        current_session_id: opencode.session_id,
    })
}

#[tauri::command]
async fn opencode_status(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
) -> Result<OpencodeStatus, String> {
    snapshot_opencode(&app, &state, run_id.as_str()).await
}

#[tauri::command]
fn codex_status(app: AppHandle, binary: Option<String>) -> Result<CodexStatus, String> {
    codex_status_snapshot(&app, binary.as_deref())
}

#[tauri::command]
fn codex_models() -> Result<Vec<CodexModel>, String> {
    Ok(read_codex_models())
}

#[tauri::command]
fn claude_status(app: AppHandle, binary: Option<String>) -> Result<CliRuntimeStatus, String> {
    claude_status_snapshot(&app, binary.as_deref())
}

#[tauri::command]
async fn claude_models(
    app: AppHandle,
    binary: Option<String>,
) -> Result<ClaudeModelsResult, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || build_claude_model_catalog(&handle, binary.as_deref()))
        .await
        .map_err(|error| format!("Claude models task failed to join: {error}"))?
}

#[tauri::command]
fn gemini_status(app: AppHandle, binary: Option<String>) -> Result<CliRuntimeStatus, String> {
    gemini_status_snapshot(&app, binary.as_deref())
}

#[tauri::command]
async fn gemini_models(
    app: AppHandle,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<GeminiModelsResult, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        run_gemini_models(&handle, binary.as_deref(), proxy.as_deref())
    })
    .await
    .map_err(|error| format!("Gemini models task failed to join: {error}"))?
}

#[tauri::command]
fn codex_update_settings(
    app: AppHandle,
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
) -> Result<CodexStatus, String> {
    write_codex_settings(model.as_deref(), reasoning_effort.as_deref())?;
    codex_status_snapshot(&app, binary.as_deref())
}

#[tauri::command]
fn codex_open_login(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    binary: Option<String>,
    device_auth: Option<bool>,
    proxy: Option<String>,
) -> Result<Value, String> {
    // 重新登录前先停掉旧的共享 app-server，下一次 ensure_* 会用新 auth 重启。
    // 否则老进程在新 auth.json 写入后仍持有过期 token，所有请求继续失败。
    reset_shared_codex_client(state.inner());
    Ok(json!({
        "message": open_codex_login_terminal(
            &app,
            binary.as_deref(),
            device_auth.unwrap_or(false),
            proxy.as_deref()
        )?
    }))
}

#[tauri::command]
fn claude_open_login(
    app: AppHandle,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    Ok(json!({
        "message": open_claude_login_terminal(
            &app,
            binary.as_deref(),
            proxy.as_deref()
        )?
    }))
}

#[tauri::command]
async fn gemini_open_login(
    app: AppHandle,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_gemini_auth(&handle, binary.as_deref(), proxy.as_deref())
    });
    let message = join
        .await
        .map_err(|error| format!("Gemini authentication task failed to join: {error}"))??;
    Ok(json!({
        "message": message
    }))
}

#[tauri::command]
async fn codex_verify(
    app: AppHandle,
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<CodexVerifyResult, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_codex_probe(
            &handle,
            model.as_deref(),
            reasoning_effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
        )
    });
    let message = join
        .await
        .map_err(|error| format!("Codex verification task failed to join: {error}"))??;
    Ok(CodexVerifyResult { ok: true, message })
}

#[tauri::command]
async fn claude_verify(
    app: AppHandle,
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<CodexVerifyResult, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_claude_probe(
            &handle,
            model.as_deref(),
            effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
        )
    });
    let message = join
        .await
        .map_err(|error| format!("Claude verification task failed to join: {error}"))??;
    Ok(CodexVerifyResult { ok: true, message })
}

#[tauri::command]
async fn gemini_verify(
    app: AppHandle,
    model: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<CodexVerifyResult, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        run_gemini_probe(
            &handle,
            model.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
        )
    });
    let message = join
        .await
        .map_err(|error| format!("Gemini verification task failed to join: {error}"))??;
    Ok(CodexVerifyResult { ok: true, message })
}

#[tauri::command]
async fn opencode_start(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    binary: Option<String>,
    proxy: Option<String>,
    port: Option<u16>,
) -> Result<OpencodeStatus, String> {
    let root = resolve_project_root(&app)?;
    // 每个 tab 启动 OpenCode 时从端口池分配独立端口，避免多 tab 抢同一个 4096
    let desired_port = allocate_opencode_port(state.inner(), port);
    let desired_binary = resolve_opencode_binary(&app, binary.as_deref());
    let desired_proxy = proxy
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let version = opencode_command_version(&desired_binary, &root)?;

    if opencode_health(desired_port).await {
        with_opencode_state(state.inner(), run_id.as_str(), |opencode| {
            opencode.binary = desired_binary.display().to_string();
            opencode.port = desired_port;
            opencode.managed = false;
        })?;
        let mut status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
        status.version = Some(version);
        return Ok(status);
    }

    let existing_listeners = listening_process_ids(desired_port).unwrap_or_default();
    if !existing_listeners.is_empty() {
        let _ = kill_opencode_listeners(&[desired_port, 1455]);

        for _ in 0..20 {
            let remaining = listening_process_ids(desired_port).unwrap_or_default();
            if remaining.is_empty() {
                break;
            }
            sleep(Duration::from_millis(250)).await;
        }

        let remaining = listening_process_ids(desired_port).unwrap_or_default();
        if !remaining.is_empty() {
            return Err(format!(
                "OpenCode port {desired_port} is already occupied by another process. Stop the existing listener and retry."
            ));
        }
    }

    let mut command = Command::new(&desired_binary);
    configure_background_command(&mut command);
    apply_opencode_runtime_env(&mut command)?;
    command
        .current_dir(&root)
        .arg("serve")
        .arg("--hostname")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(desired_port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    apply_proxy_env(&mut command, desired_proxy.as_deref());

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to start OpenCode: {error}"))?;

    with_opencode_state(state.inner(), run_id.as_str(), |opencode| {
        opencode.child = Some(child);
        opencode.port = desired_port;
        opencode.binary = desired_binary.display().to_string();
        opencode.managed = true;
    })?;

    let started_at = Instant::now();
    while started_at.elapsed() < OPENCODE_READY_TIMEOUT {
        if opencode_health(desired_port).await {
            let mut status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
            status.version = Some(version);
            return Ok(status);
        }

        let child_alive = with_opencode_state(state.inner(), run_id.as_str(), |opencode| {
            refresh_child_state(opencode);
            opencode.child.is_some()
        })?;
        if !child_alive {
            let detail = latest_opencode_log_line()
                .map(|line| format!(" Latest OpenCode log: {line}"))
                .unwrap_or_default();
            return Err(format!("OpenCode exited before becoming ready.{detail}"));
        }
        sleep(Duration::from_millis(500)).await;
    }

    Err("OpenCode did not become ready in time.".to_string())
}

#[tauri::command]
async fn opencode_stop(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
) -> Result<OpencodeStatus, String> {
    let port_to_stop = with_opencode_state(state.inner(), run_id.as_str(), |opencode| {
        let port = opencode.port;
        if let Some(child) = opencode.child.as_mut() {
            crate::gemini::kill_child_descendants(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        opencode.child = None;
        opencode.session_id = None;
        opencode.managed = false;
        port
    })?;

    let _ = kill_opencode_listeners(&[port_to_stop, 1455]);
    release_opencode_port(state.inner(), port_to_stop);

    for _ in 0..20 {
        if !opencode_health(port_to_stop).await {
            break;
        }
        sleep(Duration::from_millis(250)).await;
    }

    snapshot_opencode(&app, &state, run_id.as_str()).await
}

#[tauri::command]
async fn opencode_agents(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }
    opencode_request(status.port, Method::GET, "/agent", None, None).await
}

#[tauri::command]
async fn opencode_create_session(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    title: Option<String>,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    let payload = json!({
        "title": title.unwrap_or_else(|| "DesignCode Local Agent".to_string())
    });

    let response = opencode_request(
        status.port,
        Method::POST,
        "/session",
        Some(payload),
        directory.as_deref(),
    )
    .await?;

    if let Some(session_id) = extract_session_id(&response) {
        with_opencode_state(state.inner(), run_id.as_str(), |opencode| {
            opencode.session_id = Some(session_id);
        })?;
    }

    Ok(response)
}

#[tauri::command]
async fn codex_send_prompt(
    app: AppHandle,
    run_id: String,
    thread_id: Option<String>,
    text: String,
    system: Option<String>,
    directory: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let handle = app.clone();
    let thread_for_turn = thread_id.clone();
    let text_for_turn = text.clone();
    let system_for_turn = system.clone();
    let directory_for_turn = directory.clone();
    let model_for_turn = model.clone();
    let effort_for_turn = reasoning_effort.clone();
    let binary_for_turn = binary.clone();
    let proxy_for_turn = proxy.clone();
    let stream_for_turn = stream_id.clone();
    let run_id_for_turn = run_id.clone();
    let join = tokio::task::spawn_blocking(move || {
        let runtime = handle.state::<RuntimeState>();
        run_codex_app_server_turn(
            &handle,
            runtime.inner(),
            run_id_for_turn.as_str(),
            &directory_for_turn,
            thread_for_turn.as_deref(),
            system_for_turn.as_deref(),
            &text_for_turn,
            model_for_turn.as_deref(),
            effort_for_turn.as_deref(),
            binary_for_turn.as_deref(),
            proxy_for_turn.as_deref(),
            stream_for_turn.as_deref(),
        )
    });
    let (next_thread_id, output) = join
        .await
        .map_err(|error| format!("Codex App Server prompt task failed to join: {error}"))??;

    Ok(json!({
        "threadId": next_thread_id,
        "output": output
    }))
}

#[tauri::command]
async fn claude_send_prompt(
    app: AppHandle,
    _state: State<'_, RuntimeState>,
    run_id: String,
    session_id: Option<String>,
    text: String,
    system: Option<String>,
    directory: String,
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let prompt = if let Some(system_prompt) = system.filter(|value| !value.trim().is_empty()) {
        compose_codex_design_prompt(&system_prompt, &text)
    } else {
        text.clone()
    };

    let handle = app.clone();
    let run_id_for_turn = run_id.clone();
    let join = tokio::task::spawn_blocking(move || {
        let runtime = handle.state::<RuntimeState>();
        run_claude_stream_turn(
            &handle,
            runtime.inner(),
            run_id_for_turn.as_str(),
            &prompt,
            &directory,
            session_id.as_deref(),
            model.as_deref(),
            effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
            stream_id.as_deref(),
        )
    });
    let (next_session_id, output) = join
        .await
        .map_err(|error| format!("Claude prompt task failed to join: {error}"))??;

    Ok(json!({
        "sessionId": next_session_id,
        "output": output
    }))
}

#[tauri::command]
async fn gemini_send_prompt(
    app: AppHandle,
    run_id: String,
    session_id: Option<String>,
    text: String,
    system: Option<String>,
    directory: String,
    model: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let _ = run_id; // Gemini 已是 per-run 模式（基于 session_id），run_id 仅用于前端追踪
    let prompt = if let Some(system_prompt) = system.filter(|value| !value.trim().is_empty()) {
        compose_codex_design_prompt(&system_prompt, &text)
    } else {
        text.clone()
    };

    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        let runtime = handle.state::<RuntimeState>();
        run_gemini_exec(
            &handle,
            runtime.inner(),
            &prompt,
            &directory,
            session_id.as_deref(),
            model.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
            stream_id.as_deref(),
        )
    });
    let (next_session_id, output) = join
        .await
        .map_err(|error| format!("Gemini prompt task failed to join: {error}"))??;

    Ok(json!({
        "sessionId": next_session_id,
        "output": output
    }))
}

#[tauri::command]
async fn runtime_warmup(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    backend: String,
    directory: Option<String>,
    session_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<Value, String> {
    let backend = backend.trim().to_lowercase();
    if backend == "opencode" {
        let status = ensure_opencode_ready(&app, &state, run_id.as_str()).await?;
        return Ok(json!({
            "backend": "opencode",
            "ready": status.running,
            "port": status.port,
            "binary": status.binary
        }));
    }

    let handle = app.clone();
    let run_id_for_task = run_id.clone();
    tokio::task::spawn_blocking(move || {
        let runtime = handle.state::<RuntimeState>();
        match backend.as_str() {
            "codex" => {
                ensure_codex_app_server_client(&handle, runtime.inner(), run_id_for_task.as_str(), binary.as_deref(), proxy.as_deref())?;
                Ok(json!({
                    "backend": "codex",
                    "ready": true
                }))
            }
            "claude" => {
                let cwd = directory
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Missing workspace directory for Claude warmup.".to_string())?;
                let client = ensure_claude_stream_client(
                    &handle,
                    runtime.inner(),
                    run_id_for_task.as_str(),
                    cwd,
                    session_id.as_deref(),
                    model.as_deref(),
                    effort.as_deref(),
                    binary.as_deref(),
                    proxy.as_deref(),
                )?;
                let active_session = client
                    .session_id
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                Ok(json!({
                    "backend": "claude",
                    "ready": true,
                    "sessionId": active_session
                }))
            }
            "gemini" => {
                let cwd = directory
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "Missing workspace directory for Gemini warmup.".to_string())?;
                let client = ensure_gemini_acp_client(
                    &handle,
                    runtime.inner(),
                    cwd,
                    session_id.as_deref(),
                    model.as_deref(),
                    binary.as_deref(),
                    proxy.as_deref(),
                )?;
                let active_session = client
                    .session_id
                    .lock()
                    .ok()
                    .and_then(|value| value.clone());
                Ok(json!({
                    "backend": "gemini",
                    "ready": true,
                    "sessionId": active_session
                }))
            }
            _ => Err(format!("Unsupported runtime backend for warmup: {backend}")),
        }
    })
    .await
    .map_err(|error| format!("Runtime warmup task failed to join: {error}"))?
}

#[tauri::command]
async fn opencode_messages(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    session_id: String,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(
        status.port,
        Method::GET,
        &format!("/session/{session_id}/message"),
        None,
        directory.as_deref(),
    )
    .await
}

#[tauri::command]
async fn runtime_list_approvals(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    backend: String,
    session_id: Option<String>,
    directory: Option<String>,
) -> Result<Value, String> {
    if backend == "codex" {
        // Codex 共享子进程：approval 列表 / 回传都走共享 client，不按 run_id 分片
        let client = with_codex_state(state.inner(), CODEX_SHARED_KEY, |codex| codex.client.clone())?
            .ok_or_else(|| "Codex App Server is not running.".to_string())?;
        return Ok(Value::Array(codex_pending_approvals(&client)));
    }

    if backend == "gemini" {
        return Ok(Value::Array(gemini_pending_approvals(
            state.inner(),
            session_id.as_deref(),
        )?));
    }

    if backend != "opencode" {
        return Err(format!(
            "{backend} 当前执行 transport 尚未支持会话内审批查询。"
        ));
    }

    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    Ok(Value::Array(
        opencode_permissions_request(
            status.port,
            session_id.as_deref(),
            directory.as_deref(),
        )
        .await?,
    ))
}

#[tauri::command]
async fn runtime_reply_approval(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    backend: String,
    session_id: Option<String>,
    approval_id: String,
    decision: String,
    directory: Option<String>,
) -> Result<Value, String> {
    if backend == "codex" {
        // Codex 共享子进程：approval 列表 / 回传都走共享 client，不按 run_id 分片
        let client = with_codex_state(state.inner(), CODEX_SHARED_KEY, |codex| codex.client.clone())?
            .ok_or_else(|| "Codex App Server is not running.".to_string())?;
        return reply_codex_approval(&client, approval_id.as_str(), decision.as_str());
    }

    if backend == "gemini" {
        return reply_gemini_approval(state.inner(), approval_id.as_str(), decision.as_str());
    }

    if backend != "opencode" {
        return Err(format!(
            "{backend} 当前执行 transport 尚未支持会话内审批回传。"
        ));
    }

    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_reply_permission(
        status.port,
        session_id.as_deref(),
        approval_id.as_str(),
        decision.as_str(),
        directory.as_deref(),
    )
    .await
}

#[tauri::command]
async fn opencode_send_prompt(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    session_id: String,
    agent: Option<String>,
    text: String,
    system: Option<String>,
    directory: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    let mut payload = json!({
        "parts": [
            {
                "type": "text",
                "text": text
            }
        ],
        "agent": agent.unwrap_or_else(|| "build".to_string())
    });

    if let Some(system) = system.filter(|value| !value.trim().is_empty()) {
        payload["system"] = Value::String(system);
    }

    let poller = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_permission_poller(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
            )
        });

    let event_stream = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_event_stream(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
            )
        });

    let result = opencode_request_with_timeout(
        status.port,
        Method::POST,
        &format!("/session/{session_id}/message"),
        Some(payload),
        directory.as_deref(),
        Duration::from_secs(1800),
    )
    .await;

    let mut visible_opencode_log_events = 0usize;
    if let Some((stop_tx, handle, counter)) = event_stream {
        let _ = stop_tx.send(true);
        let _ = handle.await;
        visible_opencode_log_events = counter.load(std::sync::atomic::Ordering::Relaxed);
    }
    if let Some((stop_tx, handle)) = poller {
        let _ = stop_tx.send(true);
        let _ = handle.await;
    }

    let result = result?;

    if let Some(stream_id) = stream_id.as_deref() {
        if visible_opencode_log_events == 0 {
            let _ = emit_opencode_session_snapshot_internal(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
                false,
            )
            .await;
        } else {
            let emitted = emit_opencode_message_snapshot_internal(&app, stream_id, &result, true);
            if emitted == 0 {
                let _ = emit_opencode_session_snapshot_internal(
                    &app,
                    status.port,
                    session_id.as_str(),
                    directory.as_deref(),
                    stream_id,
                    true,
                )
                .await;
            }
        }
    }

    Ok(result)
}

#[tauri::command]
async fn opencode_run_shell(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    session_id: String,
    command: String,
    directory: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    let payload = json!({
        "command": command
    });

    let poller = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_permission_poller(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
            )
        });

    let event_stream = stream_id
        .as_deref()
        .map(|stream_id| {
            spawn_opencode_event_stream(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
            )
        });

    let result = opencode_request_with_timeout(
        status.port,
        Method::POST,
        &format!("/session/{session_id}/shell"),
        Some(payload),
        directory.as_deref(),
        Duration::from_secs(1800),
    )
    .await;

    let mut visible_opencode_log_events = 0usize;
    if let Some((stop_tx, handle, counter)) = event_stream {
        let _ = stop_tx.send(true);
        let _ = handle.await;
        visible_opencode_log_events = counter.load(std::sync::atomic::Ordering::Relaxed);
    }
    if let Some((stop_tx, handle)) = poller {
        let _ = stop_tx.send(true);
        let _ = handle.await;
    }

    let result = result?;

    if let Some(stream_id) = stream_id.as_deref() {
        if visible_opencode_log_events == 0 {
            let _ = emit_opencode_session_snapshot_internal(
                &app,
                status.port,
                session_id.as_str(),
                directory.as_deref(),
                stream_id,
                false,
            )
            .await;
        } else {
            let emitted = emit_opencode_message_snapshot_internal(&app, stream_id, &result, true);
            if emitted == 0 {
                let _ = emit_opencode_session_snapshot_internal(
                    &app,
                    status.port,
                    session_id.as_str(),
                    directory.as_deref(),
                    stream_id,
                    true,
                )
                .await;
            }
        }
    }

    Ok(result)
}

#[tauri::command]
fn workspace_shell_exec(directory: String, command: String) -> Result<Value, String> {
    #[cfg(target_os = "windows")]
    let mut process = {
        let mut process = Command::new("cmd");
        configure_background_command(&mut process);
        process.args(["/C", command.as_str()]);
        process
    };

    #[cfg(not(target_os = "windows"))]
    let mut process = {
        let mut process = Command::new("/bin/zsh");
        process.args(["-lc", command.as_str()]);
        process
    };

    let output = process
        .current_dir(directory)
        .output()
        .map_err(|error| format!("Failed to execute shell command: {error}"))?;

    Ok(json!({
        "stdout": trim_output(&output.stdout),
        "stderr": trim_output(&output.stderr),
        "exitCode": output.status.code()
    }))
}

#[tauri::command]
async fn opencode_provider_list(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(status.port, Method::GET, "/provider", None, directory.as_deref()).await
}

#[tauri::command]
async fn opencode_provider_auth(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(
        status.port,
        Method::GET,
        "/provider/auth",
        None,
        directory.as_deref(),
    )
    .await
}

#[tauri::command]
async fn opencode_provider_authorize(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    provider_id: String,
    method: u64,
    directory: Option<String>,
    open_browser: Option<bool>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    let mut response = opencode_request(
        status.port,
        Method::POST,
        &format!("/provider/{provider_id}/oauth/authorize"),
        Some(json!({ "method": method })),
        directory.as_deref(),
    )
    .await?;

    if open_browser.unwrap_or(false) {
        if let Some(url) = response
            .get("url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
        {
            if let Some(object) = response.as_object_mut() {
                match open_auth_window(&app, &url) {
                    Ok(()) => {
                        object.insert("browserOpened".to_string(), Value::Bool(true));
                        object.insert(
                            "authSurface".to_string(),
                            Value::String("embedded".to_string()),
                        );
                    }
                    Err(_) => {
                        open_external_url(&url)?;
                        object.insert("browserOpened".to_string(), Value::Bool(true));
                        object.insert(
                            "authSurface".to_string(),
                            Value::String("external".to_string()),
                        );
                    }
                }
            }
        }
    }

    Ok(response)
}

#[tauri::command]
async fn opencode_auth_diagnostic(provider_id: Option<String>) -> Result<OpencodeAuthDiagnostic, String> {
    Ok(opencode_auth_diagnostic_from_log(
        provider_id.as_deref().unwrap_or("openai"),
    ))
}

#[tauri::command]
async fn opencode_config_get(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(status.port, Method::GET, "/config", None, directory.as_deref()).await
}

#[tauri::command]
async fn opencode_config_providers(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(
        status.port,
        Method::GET,
        "/config/providers",
        None,
        directory.as_deref(),
    )
    .await
}

#[tauri::command]
async fn opencode_config_update(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    payload: Value,
    directory: Option<String>,
) -> Result<Value, String> {
    let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
    if !status.running {
        return Err("OpenCode server is not running.".to_string());
    }

    opencode_request(
        status.port,
        Method::PATCH,
        "/config",
        Some(payload),
        directory.as_deref(),
    )
    .await
}

#[tauri::command]
async fn opencode_preferences_get(app: AppHandle) -> Result<Value, String> {
    let preferences = load_opencode_preferences(&app)?;
    let secrets = load_opencode_provider_secrets(&app)?;
    Ok(opencode_preferences_public_value(&preferences, &secrets))
}

#[tauri::command]
async fn opencode_preferences_update(app: AppHandle, payload: Value) -> Result<Value, String> {
    let mut preferences = load_opencode_preferences(&app)?;
    let mut secrets = load_opencode_provider_secrets(&app)?;

    if let Some(value) = payload.get("selectedProviderId").and_then(Value::as_str) {
        preferences.selected_provider_id = value.trim().to_string();
    }
    if let Some(value) = payload.get("selectedModelId").and_then(Value::as_str) {
        preferences.selected_model_id = value.trim().to_string();
    }
    if let Some(value) = payload.get("smallModelId").and_then(Value::as_str) {
        preferences.small_model_id = value.trim().to_string();
    }

    let provider_id = payload
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    if let Some(provider_id) = provider_id.as_ref() {
        let base_url = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let model_id = payload
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();

        let provider_preference = preferences
            .providers
            .entry(provider_id.clone())
            .or_default();
        provider_preference.base_url = base_url;
        provider_preference.model_id = model_id;

        if provider_preference.base_url.is_empty() && provider_preference.model_id.is_empty() {
            preferences.providers.remove(provider_id);
        }

        if payload
            .get("updateApiKey")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let api_key = payload
                .get("apiKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            if api_key.is_empty() {
                secrets.providers.remove(provider_id);
            } else {
                secrets
                    .providers
                    .entry(provider_id.clone())
                    .or_default()
                    .api_key = api_key;
            }
        }
    }

    save_opencode_preferences(&app, &preferences)?;
    save_opencode_provider_secrets(&app, &secrets)?;
    Ok(opencode_preferences_public_value(&preferences, &secrets))
}

#[tauri::command]
async fn opencode_provider_secret_get(app: AppHandle, provider_id: String) -> Result<Value, String> {
    let provider_id = provider_id.trim().to_string();
    if provider_id.is_empty() {
        return Ok(json!({
            "providerId": "",
            "apiKey": "",
            "hasApiKey": false
        }));
    }

    let secrets = load_opencode_provider_secrets(&app)?;
    let api_key = secrets
        .providers
        .get(&provider_id)
        .map(|entry| entry.api_key.trim().to_string())
        .unwrap_or_default();

    Ok(json!({
        "providerId": provider_id,
        "apiKey": api_key,
        "hasApiKey": !api_key.is_empty()
    }))
}

// ---------------------------------------------------------------------------
// 多标签页：清理指定 tab 名下所有运行时子进程
// ---------------------------------------------------------------------------

#[tauri::command]
async fn runtime_cleanup_tab(
    state: State<'_, RuntimeState>,
    run_id: String,
) -> Result<(), String> {
    // OpenCode：杀子进程并释放端口槽位
    let port_to_release = {
        let mut map = state
            .opencode
            .lock()
            .map_err(|_| "Failed to lock OpenCode state map.")?;
        if let Some(mut run) = map.remove(run_id.as_str()) {
            if let Some(child) = run.child.as_mut() {
                // 先递归清掉 opencode 派生的 node 子孙，再杀主进程
                crate::gemini::kill_child_descendants(child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
            Some(run.port)
        } else {
            None
        }
    };
    if let Some(port) = port_to_release {
        let _ = kill_opencode_listeners(&[port]);
        release_opencode_port(state.inner(), port);
    }

    // Codex 是共享子进程（多 tab 共用一个 app-server，靠 thread_id 区分会话），
    // 不在单 tab 关闭时杀掉——那样会把正在工作的其它 tab 一起打断。
    // 共享 client 的停掉时机：登录变更 / 应用退出 / shutdown_runtime_children。

    // Claude：移除 client 并 kill
    let claude_client = state
        .claude
        .lock()
        .ok()
        .and_then(|mut map| map.remove(run_id.as_str()))
        .and_then(|mut s| s.client.take());
    if let Some(client) = claude_client {
        kill_claude_stream_client(&client);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 中止当前生成 / 编辑：按 backend 分别做最佳努力终止，让前端 await 立刻失败。
// - Codex（共享进程）：移除 active_turns 中 stream_id 匹配的 turn，mpsc 通道 drop
//   后 run_codex_app_server_turn 的 rx.recv_timeout 立刻 Disconnected 报错。
// - Claude（per-tab 子进程）：杀本 tab 的子进程并 drop pending_turn，同样让 rx 断。
// - Gemini：遍历 active_runs，找 pending_turn.stream_id 匹配的 run，调 stop()。
// - OpenCode：POST /session/{session_id}/abort 让本地 opencode 服务停住当前生成。
// ---------------------------------------------------------------------------

#[tauri::command]
async fn runtime_abort(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    run_id: String,
    backend: String,
    session_id: Option<String>,
    stream_id: Option<String>,
    directory: Option<String>,
) -> Result<Value, String> {
    let backend = backend.trim().to_lowercase();
    let stream_ref = stream_id.as_deref().unwrap_or("");

    match backend.as_str() {
        "codex" => {
            // 共享 codex app-server：按 stream_id 定位本 tab 的 turn；drop 它的 waiter
            // 让 run_codex_app_server_turn 的 rx 断开、返回 Err。
            let client = with_codex_state(state.inner(), CODEX_SHARED_KEY, |s| s.client.clone())?;
            if let Some(client) = client {
                if let Ok(mut turns) = client.active_turns.lock() {
                    let matched: Vec<String> = turns
                        .iter()
                        .filter_map(|(id, turn)| {
                            if turn.stream_id.as_deref() == Some(stream_ref) {
                                Some(id.clone())
                            } else {
                                None
                            }
                        })
                        .collect();
                    for id in matched {
                        turns.remove(&id);
                    }
                }
            }
        }
        "claude" => {
            let client = with_claude_state(state.inner(), run_id.as_str(), |s| s.client.take())?;
            if let Some(client) = client {
                // 先 drop pending_turn 里的 waiter，让前端 await 瞬间失败；再杀子进程。
                if let Ok(mut pending) = client.pending_turn.lock() {
                    pending.take();
                }
                kill_claude_stream_client(&client);
            }
        }
        "gemini" => {
            // Gemini 的 active_runs 以内部 gemini-run-N 为 key，与 tab run_id 不同。
            // 按 pending_turn.stream_id 定位，停下匹配的 run。
            let runs_to_stop: Vec<Arc<GeminiAcpRun>> = if let Ok(gemini) = state.gemini.lock() {
                gemini
                    .active_runs
                    .values()
                    .filter(|run| {
                        run.pending_turn
                            .lock()
                            .ok()
                            .and_then(|guard| {
                                guard.as_ref().and_then(|turn| turn.stream_id.clone())
                            })
                            .as_deref()
                            == Some(stream_ref)
                    })
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            for run in runs_to_stop {
                if let Some(turn) = take_gemini_pending_turn(&run.pending_turn) {
                    drop(turn); // drop waiter → rx Disconnected
                }
                run.stop();
            }
        }
        "opencode" => {
            let status = snapshot_opencode(&app, &state, run_id.as_str()).await?;
            if !status.running {
                return Ok(json!({ "aborted": false, "reason": "not-running" }));
            }
            let session = session_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Missing session id for opencode abort.".to_string())?;
            let _ = opencode_request(
                status.port,
                Method::POST,
                &format!("/session/{session}/abort"),
                None,
                directory.as_deref(),
            )
            .await;
        }
        _ => {
            return Err(format!("{backend} 当前不支持中止。"));
        }
    }

    Ok(json!({ "aborted": true }))
}

// ── Update check ─────────────────────────────────────────────

// 「检查更新」走的是和 tauri-plugin-updater 相同的 latest.json，
// 从 UPDATE_CHECK_ENDPOINTS 按顺序 fallback：R2 优先（国内更快、更稳），
// 失败再退回 GitHub Release。两份 JSON 内容的 signature / version / notes / pub_date 相同，
// 只是 platforms[*].url 字段指向不同源——命中哪边就走哪边的下载。
const UPDATE_CHECK_ENDPOINTS: &[&str] = &[
    "https://designcode.harucdn.com/latest.json",
    "https://github.com/haruhiyuki/DesignCode/releases/latest/download/latest.json",
];

// latest.json schema（和 tauri-plugin-updater 标准一致）：
// {
//   "version": "1.0.4",
//   "notes": "...",
//   "pub_date": "2026-...",
//   "platforms": {
//     "darwin-aarch64": { "signature": "...", "url": "https://..." },
//     "darwin-x86_64":  { ... },
//     "windows-x86_64": { ... }
//   }
// }
fn latest_json_platform_key() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64"
        } else {
            "darwin-x86_64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "linux") {
        "linux-x86_64"
    } else {
        ""
    }
}

fn version_is_newer(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim_start_matches('v')
            .split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect()
    };
    let c = parse(current);
    let l = parse(latest);
    l > c
}

#[tauri::command]
async fn check_for_updates(app: AppHandle, proxy: Option<String>) -> Result<UpdateCheckResult, String> {
    let current_version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(format!("DesignCode/{current_version}"));

    if let Some(proxy_url) = resolve_proxy_value(proxy.as_deref()) {
        if let Ok(p) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(p);
        }
    }

    let client = builder.build().map_err(|e| e.to_string())?;

    // 依次尝试每个 endpoint，第一个成功的用它；全失败时把最后一次错误返回。
    let mut last_error: Option<String> = None;
    for endpoint in UPDATE_CHECK_ENDPOINTS {
        match client.get(*endpoint).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Value>().await {
                    Ok(body) => {
                        let latest_version = body["version"]
                            .as_str()
                            .unwrap_or("")
                            .trim_start_matches('v')
                            .to_string();
                        let notes = body["notes"].as_str().map(String::from);
                        let published = body["pub_date"].as_str().map(String::from);

                        let plat_key = latest_json_platform_key();
                        let download_url = body
                            .get("platforms")
                            .and_then(|p| p.get(plat_key))
                            .and_then(|entry| entry.get("url"))
                            .and_then(Value::as_str)
                            .map(String::from);

                        // release_url：尝试从 endpoint 里推导（R2 的话指向其 base，
                        // GitHub 的话指向 releases/tag）——对用户来说点了是进「看版本页」。
                        let release_url = if endpoint.contains("github.com") {
                            Some(format!(
                                "https://github.com/haruhiyuki/DesignCode/releases/tag/v{latest_version}"
                            ))
                        } else {
                            download_url.clone()
                        };

                        let update_available =
                            !latest_version.is_empty() && version_is_newer(&current_version, &latest_version);

                        return Ok(UpdateCheckResult {
                            current_version,
                            latest_version: if latest_version.is_empty() {
                                None
                            } else {
                                Some(latest_version)
                            },
                            update_available,
                            release_url,
                            release_notes: notes,
                            download_url,
                            published_at: published,
                            check_error: None,
                        });
                    }
                    Err(e) => {
                        last_error = Some(format!("{endpoint}: invalid JSON ({e})"));
                    }
                }
            }
            Ok(resp) => {
                last_error = Some(format!("{endpoint}: HTTP {}", resp.status()));
            }
            Err(e) => {
                last_error = Some(format!("{endpoint}: {e}"));
            }
        }
    }

    Ok(UpdateCheckResult {
        current_version,
        latest_version: None,
        update_available: false,
        release_url: None,
        release_notes: None,
        download_url: None,
        published_at: None,
        check_error: last_error.or_else(|| Some("All update endpoints failed.".to_string())),
    })
}

#[tauri::command]
fn rebuild_menu(app: AppHandle, locale: String) -> Result<(), String> {
    let menu = menu::build_app_menu(&app, &locale)?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_system_locale() -> String {
    // Try LANG env on Unix, or default
    if let Ok(lang) = std::env::var("LANG") {
        let normalized = lang.replace('_', "-").to_lowercase();
        if normalized.starts_with("zh-cn") || normalized.starts_with("zh-hans") {
            return "zh-CN".to_string();
        }
        if normalized.starts_with("ja") {
            return "ja".to_string();
        }
        if normalized.starts_with("en") {
            return "en".to_string();
        }
    }

    // macOS: read AppleLanguages
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output();
        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
            if text.contains("zh-hans") || text.contains("zh-cn") {
                return "zh-CN".to_string();
            }
            if text.contains("ja") {
                return "ja".to_string();
            }
        }
    }

    "en".to_string()
}

// 打开系统下载目录（可选在 Windows/macOS 上高亮某个文件）。
// 前端导出使用 <a download> 触发 webview 下载，文件落在用户默认下载目录
// （~/Downloads 或 %USERPROFILE%\Downloads），这里只负责把该目录在系统文件
// 管理器里打开；如果给了 file_name，Finder/Explorer 会定位到该文件。
#[tauri::command]
fn reveal_download_folder(file_name: Option<String>) -> Result<(), String> {
    let home = user_home_dir().ok_or_else(|| "Unable to resolve user home directory.".to_string())?;
    let downloads = home.join("Downloads");
    let target_file = file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|name| downloads.join(name))
        .filter(|path| path.exists());

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if let Some(path) = target_file {
            command.arg("-R").arg(path);
        } else {
            command.arg(&downloads);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to open Downloads folder: {error}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("explorer.exe");
        configure_background_command(&mut command);
        if let Some(path) = target_file {
            command.arg(format!("/select,{}", path.display()));
        } else {
            command.arg(&downloads);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // explorer.exe 对非零退出码很敏感；忽略状态，只要 spawn 成功就算成功
            .spawn()
            .map_err(|error| format!("Failed to open Downloads folder: {error}"))?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux 的 xdg-open 无法直接高亮文件，退化为打开目录。
        let _ = target_file;
        Command::new("xdg-open")
            .arg(&downloads)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Failed to open Downloads folder: {error}"))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// 应用入口
// ---------------------------------------------------------------------------

fn main() {
    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let locale = get_system_locale();
            if let Ok(menu) = menu::build_app_menu(app.handle(), &locale) {
                let _ = app.set_menu(menu);
            }
            app.on_menu_event(|app, event| {
                let _ = app.emit(MENU_ACTION_EVENT, json!({ "action": event.id.0 }));
            });
            cleanup_stale_runtime_orphans(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_catalog,
            desktop_generate_design,
            desktop_edit_design,
            desktop_designs_list,
            desktop_design_create,
            desktop_art_assets_list,
            desktop_art_asset_import,
            desktop_art_asset_import_paths,
            desktop_art_asset_update,
            desktop_art_asset_delete,
            desktop_art_asset_preview,
            desktop_design_open,
            desktop_design_delete,
            desktop_design_update,
            desktop_design_update_html,
            desktop_design_commit_read,
            desktop_design_attach_session,
            desktop_design_sync_workspace,
            desktop_context,
            opencode_status,
            codex_status,
            claude_status,
            gemini_status,
            codex_models,
            claude_models,
            gemini_models,
            codex_update_settings,
            codex_open_login,
            claude_open_login,
            gemini_open_login,
            codex_verify,
            claude_verify,
            gemini_verify,
            opencode_start,
            opencode_stop,
            opencode_agents,
            opencode_create_session,
            codex_send_prompt,
            claude_send_prompt,
            gemini_send_prompt,
            runtime_warmup,
            opencode_provider_list,
            opencode_provider_auth,
            opencode_provider_authorize,
            opencode_auth_diagnostic,
            opencode_config_get,
            opencode_config_providers,
            opencode_config_update,
            opencode_preferences_get,
            opencode_preferences_update,
            opencode_provider_secret_get,
            opencode_messages,
            runtime_list_approvals,
            runtime_reply_approval,
            opencode_send_prompt,
            opencode_run_shell,
            workspace_shell_exec,
            runtime_cleanup_tab,
            runtime_abort,
            check_for_updates,
            rebuild_menu,
            get_system_locale,
            reveal_download_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // macOS 默认关窗不退 app，只把窗口收进 Dock —— 这样不仅 UI 奇怪，
                // 更致命的是我们的 shutdown_runtime_children 永远不会跑（app 还活着），
                // 等用户用 Force Quit 退出时是 SIGKILL，子进程全漏成残留。
                // 主窗口关就直接触发应用退出，走 ExitRequested → 正常清理流程。
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } if label != "opencode-auth" => {
                    // opencode-auth 是 OAuth 弹出的小窗口，关它不影响主 app；
                    // 其它窗口（主窗口）关闭 = 用户要退出，走 exit 触发 shutdown
                    app.exit(0);
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    let _ = api;
                    shutdown_runtime_children(app);
                }
                tauri::RunEvent::Exit => {
                    shutdown_runtime_children(app);
                }
                _ => {}
            }
        });
}
