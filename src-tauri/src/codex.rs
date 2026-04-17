// Codex App Server 子系统。
// 通过 JSON-RPC 与 codex app-server 进程通信，管理 thread/turn 生命周期、
// approval 审批流、配置读写、模型列表、登录状态检测。

use crate::types::*;
use crate::utils::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;

use std::fs;

// ---------------------------------------------------------------------------
// Codex 块事件
// ---------------------------------------------------------------------------

pub fn emit_codex_block(app: &AppHandle, stream_id: &str, block: Value) {
    emit_cli_stream_json_event(
        app,
        "codex",
        stream_id,
        &json!({
            "type": "designcode.block",
            "block": block
        }),
    );
}

pub fn split_codex_todo_items(text: &str) -> Vec<Value> {
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }

    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let label = line
                .trim_start_matches(|ch: char| {
                    ch.is_ascii_digit()
                        || ch == '.'
                        || ch == '-'
                        || ch == '*'
                        || ch == '['
                        || ch == ']'
                        || ch.is_whitespace()
                })
                .trim();
            json!({
                "id": format!("todo-{index}"),
                "label": if label.is_empty() { *line } else { label },
                "status": "pending"
            })
        })
        .collect()
}

pub fn codex_stream_id_for_thread(
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    thread_id: Option<&str>,
) -> Option<String> {
    let thread_id = thread_id?.trim();
    if thread_id.is_empty() {
        return None;
    }

    thread_streams
        .lock()
        .ok()
        .and_then(|streams| streams.get(thread_id).cloned())
}

pub fn emit_codex_error_for_thread(
    app: &AppHandle,
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    thread_id: Option<&str>,
    line: &str,
) {
    if let Some(stream_id) = codex_stream_id_for_thread(thread_streams, thread_id) {
        emit_cli_stream_line(app, "codex", &stream_id, "stderr", line);
    }
}

pub fn append_codex_map_text(
    map: &mut HashMap<String, String>,
    item_id: &str,
    delta: &str,
) -> String {
    let entry = map.entry(item_id.to_string()).or_default();
    entry.push_str(delta);
    entry.clone()
}

// ---------------------------------------------------------------------------
// 块状态/构建辅助
// ---------------------------------------------------------------------------

pub fn command_block_status(status: Option<&str>) -> &'static str {
    match status.unwrap_or_default() {
        "completed" => "success",
        "failed" | "declined" => "error",
        _ => "running",
    }
}

pub fn codex_command_output_block(
    item_id: &str,
    command: &str,
    output: &str,
    status: &str,
    suppress_log_line: bool,
) -> Value {
    json!({
        "id": item_id,
        "type": "command",
        "command": command,
        "output": output,
        "status": status,
        "backend": "codex",
        "suppressLogLine": suppress_log_line
    })
}

pub fn codex_text_block(
    item_id: &str,
    block_type: &str,
    content: &str,
    tone: Option<&str>,
    suppress_log_line: bool,
) -> Value {
    let mut block = json!({
        "id": item_id,
        "type": block_type,
        "content": content,
        "backend": "codex",
        "suppressLogLine": suppress_log_line
    });
    if let Some(tone) = tone {
        if let Some(object) = block.as_object_mut() {
            object.insert("tone".to_string(), Value::String(tone.to_string()));
        }
    }
    block
}

pub fn codex_todo_block(
    item_id: &str,
    text: &str,
    status: &str,
    suppress_log_line: bool,
) -> Value {
    json!({
        "id": item_id,
        "type": "todo",
        "title": "Todo List",
        "items": split_codex_todo_items(text),
        "status": status,
        "backend": "codex",
        "suppressLogLine": suppress_log_line
    })
}

pub fn codex_turn_failure_message(turn: &Value) -> Option<String> {
    turn.get("error")
        .and_then(|error| error.get("message").or(Some(error)))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

// ---------------------------------------------------------------------------
// impl CodexAppServerClient
// ---------------------------------------------------------------------------

impl CodexAppServerClient {
    pub fn is_alive(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .flatten()
            .is_none()
    }

    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            // 先递归清理子进程树，防止 Codex CLI 的子进程残留
            use crate::gemini::kill_child_descendants;
            kill_child_descendants(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn send_request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (tx, rx) = mpsc::channel();

        self.pending_responses
            .lock()
            .map_err(|_| "Failed to lock Codex response map.".to_string())?
            .insert(request_id.clone(), tx);

        let request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        });

        let line = serde_json::to_string(&request)
            .map_err(|error| format!("Failed to encode Codex App Server request: {error}"))?;

        {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| "Failed to lock Codex App Server stdin.".to_string())?;
            stdin
                .write_all(line.as_bytes())
                .map_err(|error| format!("Failed to write Codex App Server request: {error}"))?;
            stdin
                .write_all(b"\n")
                .map_err(|error| format!("Failed to finalize Codex App Server request: {error}"))?;
            stdin
                .flush()
                .map_err(|error| format!("Failed to flush Codex App Server request: {error}"))?;
        }

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = self
                    .pending_responses
                    .lock()
                    .map(|mut pending| pending.remove(&request_id));
                Err(format!(
                    "Codex App Server request timed out after {}s.",
                    timeout.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(
                "Codex App Server closed before returning a response.".to_string()
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Approval 相关
// ---------------------------------------------------------------------------

pub fn resolve_codex_response_error(value: &Value) -> String {
    value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "Codex App Server returned an unknown error.".to_string())
}

pub fn build_codex_approval_block(
    method: &str,
    request_id: &str,
    params: &Value,
) -> Value {
    let approval_id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(request_id)
        .to_string();
    let reason = params
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let interactive = !matches!(method, "item/tool/requestUserInput");

    let (title, command, extra) = match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => (
            "需要确认执行命令",
            params.get("command").and_then(Value::as_str).map(ToOwned::to_owned),
            params
                .get("cwd")
                .and_then(Value::as_str)
                .map(|cwd| format!("目录：{cwd}")),
        ),
        "item/fileChange/requestApproval" | "applyPatchApproval" => (
            "需要确认写入文件",
            None,
            params
                .get("grantRoot")
                .and_then(Value::as_str)
                .map(|root| format!("范围：{root}")),
        ),
        "item/permissions/requestApproval" => (
            "需要确认额外权限",
            None,
            Some("本轮操作请求额外的文件、网络或系统权限。".to_string()),
        ),
        "item/tool/requestUserInput" => (
            "需要补充输入",
            None,
            Some("当前请求需要结构化用户输入，桌面端稍后再补这类表单回传。".to_string()),
        ),
        _ => ("需要确认执行", None, None),
    };

    let mut parts = Vec::new();
    if !reason.is_empty() {
        parts.push(reason);
    }
    if let Some(command) = command.as_ref().filter(|value| !value.trim().is_empty()) {
        parts.push(format!("命令：{command}"));
    }
    if let Some(extra) = extra.filter(|value| !value.trim().is_empty()) {
        parts.push(extra);
    }
    let content = if parts.is_empty() {
        "当前操作需要确认后才能继续执行。".to_string()
    } else {
        parts.join("\n")
    };

    json!({
        "id": approval_id,
        "type": "confirm",
        "title": title,
        "content": content,
        "command": command,
        "status": "waiting",
        "interactive": interactive,
        "backend": "codex",
        "sessionId": params.get("threadId").cloned().unwrap_or(Value::Null),
        "approvalId": approval_id,
        "note": if interactive { "" } else { "当前请求需要结构化用户输入，暂未接入这类回传。" },
        "suppressLogLine": false
    })
}

pub fn write_codex_app_server_response(
    client: &CodexAppServerClient,
    request_id: &Value,
    result: Value,
) -> Result<(), String> {
    let response = json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result
    });
    let line = serde_json::to_string(&response)
        .map_err(|error| format!("Failed to encode Codex approval response: {error}"))?;
    let mut stdin = client
        .stdin
        .lock()
        .map_err(|_| "Failed to lock Codex App Server stdin.".to_string())?;
    stdin
        .write_all(line.as_bytes())
        .map_err(|error| format!("Failed to write Codex approval response: {error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("Failed to finalize Codex approval response: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Codex approval response: {error}"))?;
    Ok(())
}

pub fn build_codex_approval_response(
    method: &str,
    params: &Value,
    decision: &str,
) -> Result<Value, String> {
    let result = match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            let available = params
                .get("availableDecisions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let accepts_for_session = available.iter().any(|item| item.as_str() == Some("acceptForSession"));
            let selected = match decision {
                "session" if accepts_for_session => "acceptForSession",
                "once" | "confirm" | "approve" | "approved" | "allow" | "session" => "accept",
                "cancel" => "cancel",
                _ => "decline",
            };
            json!({ "decision": selected })
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => {
            let selected = match decision {
                "session" => "acceptForSession",
                "once" | "confirm" | "approve" | "approved" | "allow" => "accept",
                "cancel" => "cancel",
                _ => "decline",
            };
            json!({ "decision": selected })
        }
        "item/permissions/requestApproval" => {
            let permissions = params
                .get("permissions")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if matches!(decision, "once" | "confirm" | "approve" | "approved" | "allow" | "session") {
                json!({
                    "permissions": permissions,
                    "scope": if decision == "session" { "session" } else { "turn" }
                })
            } else {
                json!({
                    "permissions": {},
                    "scope": "turn"
                })
            }
        }
        _ => {
            return Err("当前 Codex 请求类型还没有接入交互回传。".to_string());
        }
    };

    Ok(result)
}

pub fn codex_should_auto_approve_request(
    method: &str,
    params: &Value,
    active_turns: &Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
) -> bool {
    if !matches!(method, "item/fileChange/requestApproval" | "applyPatchApproval") {
        return false;
    }

    let Some(turn_id) = params.get("turnId").and_then(Value::as_str) else {
        return params.get("grantRoot").and_then(Value::as_str).is_none();
    };

    let working_dir = active_turns
        .lock()
        .ok()
        .and_then(|turns| turns.get(turn_id).map(|turn| turn.working_dir.clone()));
    let Some(working_dir) = working_dir else {
        return params.get("grantRoot").and_then(Value::as_str).is_none();
    };

    let Some(grant_root) = params.get("grantRoot").and_then(Value::as_str) else {
        return true;
    };

    Path::new(grant_root).starts_with(Path::new(&working_dir))
}

// ---------------------------------------------------------------------------
// App Server 消息处理
// ---------------------------------------------------------------------------

pub fn handle_codex_app_server_response(
    pending_responses: &Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    value: &Value,
) {
    let request_id = value
        .get("id")
        .and_then(json_rpc_id_string);
    let Some(request_id) = request_id else {
        return;
    };

    let sender = pending_responses
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    let Some(sender) = sender else {
        return;
    };

    if value.get("error").is_some() {
        let _ = sender.send(Err(resolve_codex_response_error(value)));
        return;
    }

    let _ = sender.send(Ok(value.get("result").cloned().unwrap_or(Value::Null)));
}

pub fn handle_codex_app_server_request(
    app: &AppHandle,
    client: &CodexAppServerClient,
    active_turns: &Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    pending_approvals: &Arc<Mutex<HashMap<String, CodexPendingApproval>>>,
    value: &Value,
) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let Some(request_id_key) = value.get("id").and_then(json_rpc_id_string) else {
        return;
    };
    let request_id = value.get("id").cloned().unwrap_or(Value::Null);
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let block = build_codex_approval_block(method, &request_id_key, &params);
    let approval_id = block
        .get("approvalId")
        .and_then(Value::as_str)
        .unwrap_or(&request_id_key)
        .to_string();
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let record = CodexPendingApproval {
        approval_id: approval_id.clone(),
        request_id,
        request_id_key,
        method: method.to_string(),
        params,
        block: block.clone(),
    };

    if codex_should_auto_approve_request(method, &record.params, active_turns) {
        if let Ok(result) = build_codex_approval_response(method, &record.params, "session") {
            if write_codex_app_server_response(client, &record.request_id, result).is_ok() {
                return;
            }
        }
    }

    if let Ok(mut approvals) = pending_approvals.lock() {
        approvals.insert(approval_id, record);
    }

    if let Some(stream_id) = codex_stream_id_for_thread(thread_streams, thread_id.as_deref()) {
        emit_codex_block(app, &stream_id, block);
    }
}

pub fn codex_stream_id_for_turn(
    active_turns: &Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
) -> Option<String> {
    if let Some(turn_id) = turn_id.filter(|value| !value.trim().is_empty()) {
        if let Some(stream_id) = active_turns
            .lock()
            .ok()
            .and_then(|turns| turns.get(turn_id).and_then(|turn| turn.stream_id.clone()))
        {
            return Some(stream_id);
        }
    }

    codex_stream_id_for_thread(thread_streams, thread_id)
}

pub fn handle_codex_app_server_notification(
    app: &AppHandle,
    active_turns: &Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    pending_approvals: &Arc<Mutex<HashMap<String, CodexPendingApproval>>>,
    value: &Value,
) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let thread_id = params.get("threadId").and_then(Value::as_str);
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.get("turn").and_then(|turn| turn.get("id")).and_then(Value::as_str));
    let stream_id = codex_stream_id_for_turn(active_turns, thread_streams, thread_id, turn_id);

    if method == "serverRequest/resolved" {
        let request_id = params.get("requestId").and_then(json_rpc_id_string);
        if let Some(request_id) = request_id {
            let matched = pending_approvals
                .lock()
                .ok()
                .and_then(|mut approvals| {
                    let key = approvals
                        .iter()
                        .find_map(|(key, approval)| {
                            if approval.request_id_key == request_id {
                                Some(key.clone())
                            } else {
                                None
                            }
                        });
                    key.and_then(|key| approvals.remove(&key))
                });
            if let (Some(stream_id), Some(record)) = (stream_id.clone(), matched) {
                let mut block = record.block.clone();
                if let Some(object) = block.as_object_mut() {
                    object.insert("status".to_string(), Value::String("resolved".to_string()));
                    object.insert("interactive".to_string(), Value::Bool(false));
                    object.insert("note".to_string(), Value::String("Codex 已接收当前选择。".to_string()));
                    object.insert("suppressLogLine".to_string(), Value::Bool(true));
                }
                emit_codex_block(app, &stream_id, block);
            }
        }
        return;
    }

    match method {
        "turn/started" => {
            if let Some(stream_id) = stream_id {
                emit_cli_stream_line(app, "codex", &stream_id, "stdout", "Turn started");
            }
        }
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or(Value::Null);
            let turn_status = turn.get("status").and_then(Value::as_str).unwrap_or("completed");
            if let Some(turn_id) = turn_id {
                let completed = active_turns
                    .lock()
                    .ok()
                    .and_then(|mut turns| turns.remove(turn_id));
                if let Some(active_turn) = completed {
                    if let Some(stream_id) = active_turn.stream_id.as_deref() {
                        if turn_status == "failed" {
                            if let Some(message) = codex_turn_failure_message(&turn) {
                                emit_cli_stream_line(app, "codex", stream_id, "stderr", &message);
                            }
                        }
                    }
                    let result = if turn_status == "failed" {
                        Err(codex_turn_failure_message(&turn)
                            .unwrap_or_else(|| "Codex turn failed.".to_string()))
                    } else {
                        Ok(active_turn.last_message)
                    };
                    if let Some(waiter) = active_turn.waiter {
                        let _ = waiter.send(result);
                    }
                }
            }

            if let Some(thread_id) = thread_id {
                let _ = thread_streams
                    .lock()
                    .map(|mut streams| streams.remove(thread_id));
            }
        }
        "item/started" | "item/completed" => {
            let Some(item) = params.get("item") else {
                return;
            };
            let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
            let item_id = item.get("id").and_then(Value::as_str).unwrap_or("");
            let phase = if method == "item/started" { "running" } else { "success" };
            let Some(stream_id) = stream_id else {
                return;
            };

            match item_type {
                "commandExecution" => {
                    let command = item
                        .get("command")
                        .and_then(Value::as_str)
                        .unwrap_or("command_execution");
                    let output = item
                        .get("aggregatedOutput")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let status = command_block_status(item.get("status").and_then(Value::as_str));
                    if let Some(turn_id) = turn_id {
                        if let Ok(mut turns) = active_turns.lock() {
                            if let Some(active_turn) = turns.get_mut(turn_id) {
                                active_turn
                                    .command_labels
                                    .insert(item_id.to_string(), command.to_string());
                                active_turn
                                    .command_outputs
                                    .insert(item_id.to_string(), output.to_string());
                            }
                        }
                    }
                    emit_codex_block(
                        app,
                        &stream_id,
                        codex_command_output_block(
                            item_id,
                            command,
                            output,
                            if method == "item/started" { "running" } else { status },
                            method == "item/completed",
                        ),
                    );
                }
                "plan" => {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                    if let Some(turn_id) = turn_id {
                        if let Ok(mut turns) = active_turns.lock() {
                            if let Some(active_turn) = turns.get_mut(turn_id) {
                                active_turn
                                    .todo_text
                                    .insert(item_id.to_string(), text.to_string());
                            }
                        }
                    }
                    emit_codex_block(
                        app,
                        &stream_id,
                        codex_todo_block(
                            item_id,
                            text,
                            phase,
                            method == "item/completed",
                        ),
                    );
                }
                "reasoning" => {
                    let text = item
                        .get("summary")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .filter(|value| !value.trim().is_empty())
                        .or_else(|| {
                            item.get("content").and_then(Value::as_array).map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                        })
                        .unwrap_or_default();
                    if !text.trim().is_empty() {
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_text_block(
                                item_id,
                                "thought",
                                &text,
                                None,
                                true,
                            ),
                        );
                    }
                }
                "agentMessage" => {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                    if !text.trim().is_empty() {
                        if let Some(turn_id) = turn_id {
                            if let Ok(mut turns) = active_turns.lock() {
                                if let Some(active_turn) = turns.get_mut(turn_id) {
                                    active_turn.last_message = text.to_string();
                                    active_turn
                                        .message_text
                                        .insert(item_id.to_string(), text.to_string());
                                }
                            }
                        }
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_text_block(
                                item_id,
                                "text",
                                text,
                                None,
                                false,
                            ),
                        );
                    }
                }
                "fileChange" => {
                    let path = item
                        .get("changes")
                        .and_then(Value::as_array)
                        .and_then(|changes| changes.first())
                        .and_then(|change| change.get("path"))
                        .and_then(Value::as_str)
                        .unwrap_or("design.html");
                    emit_codex_block(
                        app,
                        &stream_id,
                        codex_text_block(
                            item_id,
                            "text",
                            &format!("已更新 {path}"),
                            Some("file"),
                            false,
                        ),
                    );
                }
                _ => {}
            }
        }
        "item/commandExecution/outputDelta" => {
            let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
            let Some(stream_id) = stream_id else {
                return;
            };
            if let Some(turn_id) = turn_id {
                if let Ok(mut turns) = active_turns.lock() {
                    if let Some(active_turn) = turns.get_mut(turn_id) {
                        let output = append_codex_map_text(
                            &mut active_turn.command_outputs,
                            item_id,
                            delta,
                        );
                        let command = active_turn
                            .command_labels
                            .get(item_id)
                            .cloned()
                            .unwrap_or_else(|| "command_execution".to_string());
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_command_output_block(
                                item_id,
                                &command,
                                &output,
                                "running",
                                true,
                            ),
                        );
                    }
                }
            }
        }
        "item/plan/delta" => {
            let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
            let Some(stream_id) = stream_id else {
                return;
            };
            if let Some(turn_id) = turn_id {
                if let Ok(mut turns) = active_turns.lock() {
                    if let Some(active_turn) = turns.get_mut(turn_id) {
                        let text = append_codex_map_text(&mut active_turn.todo_text, item_id, delta);
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_todo_block(item_id, &text, "running", true),
                        );
                    }
                }
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
            let Some(stream_id) = stream_id else {
                return;
            };
            if let Some(turn_id) = turn_id {
                if let Ok(mut turns) = active_turns.lock() {
                    if let Some(active_turn) = turns.get_mut(turn_id) {
                        let text = append_codex_map_text(&mut active_turn.thought_text, item_id, delta);
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_text_block(item_id, "thought", &text, None, true),
                        );
                    }
                }
            }
        }
        "item/agentMessage/delta" => {
            let item_id = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let delta = params.get("delta").and_then(Value::as_str).unwrap_or("");
            let Some(stream_id) = stream_id else {
                return;
            };
            if let Some(turn_id) = turn_id {
                if let Ok(mut turns) = active_turns.lock() {
                    if let Some(active_turn) = turns.get_mut(turn_id) {
                        let text = append_codex_map_text(&mut active_turn.message_text, item_id, delta);
                        active_turn.last_message = text.clone();
                        emit_codex_block(
                            app,
                            &stream_id,
                            codex_text_block(item_id, "text", &text, None, true),
                        );
                    }
                }
            }
        }
        "error" => {
            let message = params
                .get("error")
                .and_then(|error| error.get("message").or(Some(error)))
                .and_then(Value::as_str)
                .unwrap_or("Codex App Server returned an error.");
            emit_codex_error_for_thread(app, thread_streams, thread_id, message);

            let will_retry = params
                .get("willRetry")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !will_retry {
                if let Some(turn_id) = turn_id {
                    let failed = active_turns
                        .lock()
                        .ok()
                        .and_then(|mut turns| turns.remove(turn_id));
                    if let Some(active_turn) = failed {
                        if let Some(waiter) = active_turn.waiter {
                            let _ = waiter.send(Err(message.to_string()));
                        }
                    }
                }
                if let Some(thread_id) = thread_id {
                    let _ = thread_streams
                        .lock()
                        .map(|mut streams| streams.remove(thread_id));
                }
            }
        }
        _ => {}
    }
}

pub fn handle_codex_app_server_stdout_line(
    app: &AppHandle,
    client: &CodexAppServerClient,
    pending_responses: &Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    active_turns: &Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    thread_streams: &Arc<Mutex<HashMap<String, String>>>,
    pending_approvals: &Arc<Mutex<HashMap<String, CodexPendingApproval>>>,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }

    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        for stream_id in thread_streams
            .lock()
            .ok()
            .map(|streams| streams.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
        {
            emit_cli_stream_line(app, "codex", &stream_id, "stdout", trimmed);
        }
        return;
    };

    if value.get("id").is_some() && (value.get("result").is_some() || value.get("error").is_some()) {
        handle_codex_app_server_response(pending_responses, &value);
        return;
    }

    if value.get("method").is_some() && value.get("id").is_some() {
        handle_codex_app_server_request(app, client, active_turns, thread_streams, pending_approvals, &value);
        return;
    }

    if value.get("method").is_some() {
        handle_codex_app_server_notification(app, active_turns, thread_streams, pending_approvals, &value);
    }
}

// ---------------------------------------------------------------------------
// 客户端生命周期
// ---------------------------------------------------------------------------

pub fn spawn_codex_app_server_client(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<CodexAppServerClient>, String> {
    let binary = resolve_codex_binary(app, requested_binary);
    let root = resolve_project_root(app)?;
    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    apply_codex_windows_sandbox_override(&mut command);
    command
        .current_dir(&root)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    apply_proxy_env(&mut command, proxy);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Codex App Server: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stderr.".to_string())?;

    let client = Arc::new(CodexAppServerClient {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        next_request_id: AtomicU64::new(1),
        pending_responses: Arc::new(Mutex::new(HashMap::new())),
        pending_approvals: Arc::new(Mutex::new(HashMap::new())),
        active_turns: Arc::new(Mutex::new(HashMap::new())),
        thread_streams: Arc::new(Mutex::new(HashMap::new())),
    });

    {
        let app = app.clone();
        let client_for_stdout = client.clone();
        let pending_responses = client.pending_responses.clone();
        let active_turns = client.active_turns.clone();
        let thread_streams = client.thread_streams.clone();
        let pending_approvals = client.pending_approvals.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                handle_codex_app_server_stdout_line(
                    &app,
                    &client_for_stdout,
                    &pending_responses,
                    &active_turns,
                    &thread_streams,
                    &pending_approvals,
                    &line,
                );
            }
        });
    }

    {
        let app = app.clone();
        let thread_streams = client.thread_streams.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let stream_ids = thread_streams
                    .lock()
                    .ok()
                    .map(|streams| streams.values().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                for stream_id in stream_ids {
                    emit_cli_stream_line(&app, "codex", &stream_id, "stderr", trimmed);
                }
            }
        });
    }

    client.send_request(
        "initialize",
        json!({
            "clientInfo": {
                "name": "designcode",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": Value::Null
        }),
        CODEX_APP_SERVER_REQUEST_TIMEOUT,
    )?;

    Ok(client)
}

// Codex app-server 在设计上就是「单进程多 thread_id 并发」模型：
// 多个 tab 共享同一个 app-server 子进程，靠各自的 thread_id 做会话隔离，
// turn/start 跨 thread 并发不互相干扰（stdout 事件按 turn_id 路由到每个
// tab 自己的 mpsc channel）。
//
// 早期把 Codex 做成 per-tab 子进程会引发：
//   1) 多个 codex app-server 同时抢占 ~/.codex/auth.json，OAuth 刷新冲突；
//   2) 某个 tab 重新登录后，其它 tab 的旧子进程仍然用过期 token；
//   3) `codex exec --ephemeral`（verify 路径）也会因 auth 文件并发而失败。
// 因此 Codex 强制使用共享实例，通过 CODEX_SHARED_KEY 固定存放。
pub const CODEX_SHARED_KEY: &str = "__codex_shared__";

pub fn ensure_codex_app_server_client(
    app: &AppHandle,
    state: &RuntimeState,
    _run_id: &str,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<Arc<CodexAppServerClient>, String> {
    let desired_binary = resolve_codex_binary(app, requested_binary)
        .display()
        .to_string();
    let desired_proxy = proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let reusable = with_codex_state(state, CODEX_SHARED_KEY, |codex| {
        let reusable = codex.client.as_ref().and_then(|client| {
            if client.is_alive()
                && codex.binary == desired_binary
                && codex.proxy == desired_proxy
            {
                Some(client.clone())
            } else {
                None
            }
        });
        if reusable.is_some() {
            return reusable;
        }

        if let Some(client) = codex.client.take() {
            client.stop();
        }
        codex.binary = desired_binary.clone();
        codex.proxy = desired_proxy.clone();
        None
    })?;
    if let Some(client) = reusable {
        return Ok(client);
    }

    let client = spawn_codex_app_server_client(app, Some(desired_binary.as_str()), desired_proxy.as_deref())?;
    with_codex_state(state, CODEX_SHARED_KEY, |codex| {
        codex.client = Some(client.clone());
    })?;
    Ok(client)
}

// 登出 / 重新登录后调用：彻底停掉共享 app-server，迫使下一次请求以新 auth 重启。
pub fn reset_shared_codex_client(state: &RuntimeState) {
    let client = with_codex_state(state, CODEX_SHARED_KEY, |codex| codex.client.take()).ok().flatten();
    if let Some(client) = client {
        client.stop();
    }
}

pub fn run_codex_app_server_turn(
    app: &AppHandle,
    state: &RuntimeState,
    run_id: &str,
    directory: &str,
    existing_thread_id: Option<&str>,
    system_prompt: Option<&str>,
    user_prompt: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(String, String), String> {
    let client = ensure_codex_app_server_client(app, state, run_id, requested_binary, proxy)?;

    let thread_result = if let Some(thread_id) = existing_thread_id.filter(|value| !value.trim().is_empty()) {
        client.send_request(
            "thread/resume",
            json!({
                "threadId": thread_id,
                "cwd": directory,
                "approvalPolicy": "on-failure",
                "sandbox": codex_thread_sandbox_mode(),
                "model": model,
                "baseInstructions": Value::Null,
                "developerInstructions": system_prompt.filter(|value| !value.trim().is_empty()),
                "persistExtendedHistory": false
            }),
            CODEX_APP_SERVER_REQUEST_TIMEOUT,
        )?
    } else {
        client.send_request(
            "thread/start",
            json!({
                "cwd": directory,
                "approvalPolicy": "on-failure",
                "sandbox": codex_thread_sandbox_mode(),
                "model": model,
                "baseInstructions": Value::Null,
                "developerInstructions": system_prompt.filter(|value| !value.trim().is_empty()),
                "experimentalRawEvents": false,
                "persistExtendedHistory": false
            }),
            CODEX_APP_SERVER_REQUEST_TIMEOUT,
        )?
    };

    let thread_id = read_nested_string(&thread_result, &["thread", "id"])
        .ok_or_else(|| "Codex App Server did not return a thread id.".to_string())?;
    if let Some(stream_id) = stream_id {
        client
            .thread_streams
            .lock()
            .map_err(|_| "Failed to track Codex stream state.".to_string())?
            .insert(thread_id.clone(), stream_id.to_string());
    }

    let turn_result = client.send_request(
        "turn/start",
        json!({
            "threadId": thread_id,
            "input": [{
                "type": "text",
                "text": user_prompt,
                "text_elements": []
            }],
            "cwd": directory,
            "approvalPolicy": "on-failure",
            "sandboxPolicy": codex_turn_sandbox_policy(directory),
            "effort": reasoning_effort,
            "model": model
        }),
        CODEX_APP_SERVER_REQUEST_TIMEOUT,
    )?;
    let turn_id = read_nested_string(&turn_result, &["turn", "id"])
        .ok_or_else(|| "Codex App Server did not return a turn id.".to_string())?;
    let (tx, rx) = mpsc::channel();
    client
        .active_turns
        .lock()
        .map_err(|_| "Failed to track Codex active turn.".to_string())?
        .insert(
            turn_id,
            CodexActiveTurn {
                thread_id: thread_id.clone(),
                working_dir: directory.to_string(),
                stream_id: stream_id.map(ToOwned::to_owned),
                last_message: String::new(),
                command_labels: HashMap::new(),
                command_outputs: HashMap::new(),
                todo_text: HashMap::new(),
                thought_text: HashMap::new(),
                message_text: HashMap::new(),
                waiter: Some(tx),
            },
        );

    let summary = match rx.recv_timeout(CODEX_TURN_TIMEOUT) {
        Ok(result) => result?,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = client
                .active_turns
                .lock()
                .map(|mut turns| turns.retain(|_, turn| turn.thread_id != thread_id));
            let _ = client
                .thread_streams
                .lock()
                .map(|mut streams| streams.remove(&thread_id));
            return Err(format!(
                "Codex turn timed out after {}s.",
                CODEX_TURN_TIMEOUT.as_secs()
            ));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let _ = client
                .thread_streams
                .lock()
                .map(|mut streams| streams.remove(&thread_id));
            return Err("Codex turn stream was closed unexpectedly.".to_string());
        }
    };

    Ok((thread_id, summary))
}

pub fn codex_pending_approvals(client: &CodexAppServerClient) -> Vec<Value> {
    client
        .pending_approvals
        .lock()
        .ok()
        .map(|approvals| approvals.values().map(|approval| approval.block.clone()).collect::<Vec<_>>())
        .unwrap_or_default()
}

pub fn reply_codex_approval(
    client: &CodexAppServerClient,
    approval_id: &str,
    decision: &str,
) -> Result<Value, String> {
    let approval = client
        .pending_approvals
        .lock()
        .map_err(|_| "Failed to lock Codex approval state.".to_string())?
        .remove(approval_id)
        .ok_or_else(|| "Unable to find the requested Codex approval.".to_string())?;

    let result = build_codex_approval_response(approval.method.as_str(), &approval.params, decision)?;
    write_codex_app_server_response(client, &approval.request_id, result)?;

    Ok(json!({
        "ok": true,
        "approvalId": approval.approval_id
    }))
}

// ---------------------------------------------------------------------------
// Codex 配置/模型
// ---------------------------------------------------------------------------

pub fn read_codex_root_setting(key: &str) -> Option<String> {
    let config_path = codex_config_file()?;
    let content = fs::read_to_string(config_path).ok()?;
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with('[') {
            return None;
        }
        let (lhs, value) = trimmed.split_once('=')?;
        if lhs.trim() != key {
            return None;
        }
        let normalized = value.trim().trim_matches('"').trim_matches('\'');
        if normalized.is_empty() {
            None
        } else {
            Some(normalized.to_string())
        }
    })
}

pub fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

pub fn upsert_codex_root_setting(lines: &mut Vec<String>, key: &str, value: &str) {
    let replacement = format!(r#"{key} = "{}""#, escape_toml_string(value));
    let section_index = lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len());

    for line in lines.iter_mut().take(section_index) {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }
        let Some((lhs, _)) = trimmed.split_once('=') else {
            continue;
        };
        if lhs.trim() == key {
            *line = replacement;
            return;
        }
    }

    lines.insert(section_index, replacement);
}

pub fn write_codex_settings(model: Option<&str>, reasoning_effort: Option<&str>) -> Result<(), String> {
    let config_path = codex_config_file().ok_or_else(|| "Unable to resolve Codex config path.".to_string())?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Codex config directory: {error}"))?;
    }

    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let mut lines = if content.is_empty() {
        Vec::new()
    } else {
        content.lines().map(ToOwned::to_owned).collect()
    };

    if let Some(value) = model.filter(|value| !value.trim().is_empty()) {
        upsert_codex_root_setting(&mut lines, "model", value.trim());
    }
    if let Some(value) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        upsert_codex_root_setting(&mut lines, "model_reasoning_effort", value.trim());
    }

    let output = if lines.is_empty() {
        String::new()
    } else {
        let mut joined = lines.join("\n");
        joined.push('\n');
        joined
    };

    fs::write(&config_path, output)
        .map_err(|error| format!("Failed to write Codex config: {error}"))
}

pub fn read_codex_models() -> Vec<CodexModel> {
    let Some(cache_path) = codex_models_cache_file() else {
        return Vec::new();
    };
    let content = match fs::read_to_string(cache_path) {
        Ok(content) => content,
        Err(_) => return Vec::new(),
    };
    let payload: Value = match serde_json::from_str(&content) {
        Ok(payload) => payload,
        Err(_) => return Vec::new(),
    };

    let mut models = payload
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| item.get("model").and_then(Value::as_str))
                .or_else(|| item.get("slug").and_then(Value::as_str))?;
            let visibility = item
                .get("visibility")
                .and_then(Value::as_str)
                .unwrap_or("list");
            if visibility == "hidden" {
                return None;
            }

            let supported_reasoning_levels = item
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    let effort = entry.get("effort").and_then(Value::as_str)?;
                    Some(CodexReasoningLevel {
                        effort: effort.to_string(),
                        description: entry
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                    })
                })
                .collect::<Vec<_>>();

            Some((
                item.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX),
                CodexModel {
                    id: id.to_string(),
                    name: item
                        .get("display_name")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("name").and_then(Value::as_str))
                        .or_else(|| item.get("slug").and_then(Value::as_str))
                        .unwrap_or(id)
                        .to_string(),
                    description: item
                        .get("description")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    default_reasoning_level: item
                        .get("default_reasoning_level")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    supported_reasoning_levels,
                },
            ))
        })
        .collect::<Vec<_>>();

    models.sort_by_key(|(priority, model)| (*priority, model.name.clone()));
    models.into_iter().map(|(_, model)| model).collect()
}

pub fn read_codex_default_model() -> Option<String> {
    read_codex_root_setting("model")
}

pub fn read_codex_default_reasoning_effort() -> Option<String> {
    read_codex_root_setting("model_reasoning_effort")
}

// ---------------------------------------------------------------------------
// Codex 沙盒/配置
// ---------------------------------------------------------------------------

pub fn codex_config_override(key: &str, value: &str) -> String {
    format!(r#"{key} = "{}""#, escape_toml_string(value))
}

pub fn codex_thread_sandbox_mode() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "danger-full-access"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "workspace-write"
    }
}

pub fn codex_probe_sandbox_mode() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "danger-full-access"
    }

    #[cfg(not(target_os = "windows"))]
    {
        "read-only"
    }
}

pub fn codex_turn_sandbox_policy(directory: &str) -> Value {
    #[cfg(target_os = "windows")]
    {
        let _ = directory;
        json!({
            "type": "dangerFullAccess"
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        json!({
            "type": "workspaceWrite",
            "writableRoots": [directory],
            "readOnlyAccess": { "type": "fullAccess" },
            "networkAccess": false,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false
        })
    }
}

pub fn apply_codex_windows_sandbox_override(command: &mut Command) {
    #[cfg(not(target_os = "windows"))]
    let _ = command;

    #[cfg(target_os = "windows")]
    {
        command
            .arg("-c")
            .arg(codex_config_override("windows.sandbox", "unelevated"));
    }
}

// ---------------------------------------------------------------------------
// Codex 登录/状态
// ---------------------------------------------------------------------------

pub fn codex_login_status(binary: &Path, cwd: &Path) -> Result<(bool, String, Option<String>), String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    apply_codex_windows_sandbox_override(&mut command);
    let output = command
        .arg("login")
        .arg("status")
        .current_dir(cwd)
        .output()
        .map_err(|error| format!("Failed to inspect Codex login status: {error}"))?;

    let stdout = strip_cli_warning_lines(&trim_output(&output.stdout));
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));
    let text = if !stdout.is_empty() { stdout } else { stderr };

    if text.is_empty() {
        return Ok((false, "未检测到 Codex 登录状态。".to_string(), None));
    }

    let logged_in = text.contains("Logged in");
    let auth_method = text
        .strip_prefix("Logged in using ")
        .map(|value| value.trim().to_string())
        .or_else(|| text.strip_prefix("Logged in via ").map(|value| value.trim().to_string()));

    Ok((logged_in, text, auth_method))
}

pub fn codex_status_snapshot(app: &AppHandle, requested_binary: Option<&str>) -> Result<CodexStatus, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_codex_binary(app, requested_binary);
    let version = command_version(&binary, "--version", &root);
    let installed = version.is_some();
    let (logged_in, login_status, auth_method) = if installed {
        codex_login_status(&binary, &root)?
    } else {
        (false, "未检测到 Codex CLI。".to_string(), None)
    };

    Ok(CodexStatus {
        installed,
        version,
        binary: binary.display().to_string(),
        logged_in,
        login_status,
        auth_method,
        default_model: read_codex_default_model(),
        default_reasoning_effort: read_codex_default_reasoning_effort(),
    })
}

// ---------------------------------------------------------------------------
// Codex exec/probe
// ---------------------------------------------------------------------------

pub fn extract_codex_last_message(events: &[Value]) -> String {
    events
        .iter()
        .filter_map(|event| {
            if event.get("type").and_then(Value::as_str) != Some("item.completed") {
                return None;
            }
            let item = event.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("agent_message") {
                return None;
            }
            item.get("text").and_then(Value::as_str).map(ToOwned::to_owned)
        })
        .last()
        .unwrap_or_default()
}

#[allow(dead_code)]
pub fn run_codex_exec(
    app: &AppHandle,
    prompt: &str,
    directory: &str,
    thread_id: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_codex_binary(app, requested_binary);
    let existing_thread = thread_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);

    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    apply_codex_windows_sandbox_override(&mut command);
    command.arg("exec");

    if existing_thread.is_some() {
        command
            .arg("resume")
            .current_dir(directory);
    } else {
        command
            .arg("-C")
            .arg(directory)
            .current_dir(&root);
    }

    command
        .arg("--json")
        .arg("--skip-git-repo-check");

    if existing_thread.is_some() {
        #[cfg(target_os = "windows")]
        {
            command.arg("-s").arg(codex_thread_sandbox_mode());
        }

        #[cfg(not(target_os = "windows"))]
        {
            command.arg("--full-auto");
        }
    } else {
        command.arg("-s").arg(codex_thread_sandbox_mode());
    }

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        command.arg("-m").arg(model);
    }
    if let Some(reasoning_effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        command
            .arg("-c")
            .arg(codex_config_override("model_reasoning_effort", reasoning_effort));
    }

    apply_proxy_env(&mut command, proxy);

    if let Some(existing_thread) = existing_thread.as_deref() {
        command.arg(existing_thread);
    }

    command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Codex CLI: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|error| format!("Failed to write prompt to Codex CLI: {error}"))?;
    }

    drop(child.stdin.take());

    let stdout_lines = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_lines = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));

    let stdout_handle = child.stdout.take().map(|stdout| {
        let app = app.clone();
        let lines = stdout_lines.clone();
        let stream = stream_id.map(ToOwned::to_owned);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(mut buffer) = lines.lock() {
                    buffer.push(line.clone());
                }
                if let Some(stream_id) = stream.as_deref() {
                    emit_cli_stream_line(&app, "codex", stream_id, "stdout", &line);
                }
            }
        })
    });

    let stderr_handle = child.stderr.take().map(|stderr| {
        let app = app.clone();
        let lines = stderr_lines.clone();
        let stream = stream_id.map(ToOwned::to_owned);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut buffer) = lines.lock() {
                    buffer.push(line.clone());
                }
                if let Some(stream_id) = stream.as_deref() {
                    emit_cli_stream_line(&app, "codex", stream_id, "stderr", &line);
                }
            }
        })
    });

    let status = child
        .wait()
        .map_err(|error| format!("Failed to read Codex CLI output: {error}"))?;

    if let Some(handle) = stdout_handle {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.join();
    }

    let stdout = stdout_lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();
    let stderr_raw = stderr_lines
        .lock()
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();
    let stderr = strip_cli_warning_lines(&stderr_raw);
    if !status.success() {
        return Err(if !stderr.is_empty() {
            stderr
        } else {
            trim_output(stdout.as_bytes())
        });
    }

    let mut events = Vec::new();
    let mut discovered_thread_id = None;
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line)
            .map_err(|error| format!("Failed to decode Codex event: {error}. Raw line: {line}"))?;
        if discovered_thread_id.is_none() {
            discovered_thread_id = event
                .get("thread_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        events.push(event);
    }

    let last_message = extract_codex_last_message(&events);
    Ok((discovered_thread_id.or(existing_thread), last_message))
}

pub fn open_codex_login_terminal(
    app: &AppHandle,
    requested_binary: Option<&str>,
    device_auth: bool,
    proxy: Option<&str>,
) -> Result<String, String> {
    let binary = resolve_codex_binary(app, requested_binary);
    let proxy_prefix = proxy_env_prefix(proxy);
    let mut trailing_args = vec!["login".to_string()];
    if device_auth {
        trailing_args.push("--device-auth".to_string());
    }
    let command_text = format!("{proxy_prefix}{}", shell_command_text(&binary, &[], &trailing_args));
    open_terminal_command(
        &command_text,
        if device_auth {
            "已在系统终端中打开 `codex login --device-auth`。完成登录后回到软件点\u{201c}刷新状态\u{201d}或\u{201c}验证连接\u{201d}。"
        } else {
            "已在系统终端中打开 `codex login`。完成登录后回到软件点\u{201c}刷新状态\u{201d}或\u{201c}验证连接\u{201d}。"
        },
    )
}

pub fn run_codex_probe(
    app: &AppHandle,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_codex_binary(app, requested_binary);
    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    apply_codex_windows_sandbox_override(&mut command);
    command
        .arg("exec")
        .arg("--json")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check")
        .arg("-s")
        .arg(codex_probe_sandbox_mode())
        .arg("-C")
        .arg(&root);

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        command.arg("-m").arg(model);
    }
    if let Some(reasoning_effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        command
            .arg("-c")
            .arg(codex_config_override("model_reasoning_effort", reasoning_effort));
    }

    apply_proxy_env(&mut command, proxy);

    command
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Codex probe: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(b"Reply with exactly OK.")
            .map_err(|error| format!("Failed to write probe prompt to Codex CLI: {error}"))?;
    }

    drop(child.stdin.take());

    let output = wait_child_output_with_timeout(child, CLI_VERIFY_TIMEOUT)?;

    let stdout = trim_output(&output.stdout);
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));
    if !output.status.success() {
        return Err(if !stderr.is_empty() { stderr } else { stdout });
    }

    let mut events = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line)
            .map_err(|error| format!("Failed to decode Codex probe event: {error}. Raw line: {line}"))?;
        events.push(event);
    }

    let last_message = extract_codex_last_message(&events);
    Ok(if last_message.trim().is_empty() {
        "Codex 请求已完成，但没有返回最终消息。".to_string()
    } else {
        last_message
    })
}
