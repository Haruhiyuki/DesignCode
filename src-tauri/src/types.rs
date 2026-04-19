// 应用级类型定义 — 运行时状态、API 响应结构、CLI 后端客户端

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};

// ---------------------------------------------------------------------------
// 核心运行时状态（Tauri managed state）
// ---------------------------------------------------------------------------

// 多标签页：每个 tab 拥有独立的 run_id，对应独立的后端运行时实例。
// 当无显式 run_id 时使用 DEFAULT_RUN_ID 兼容老调用路径。
#[allow(dead_code)]
pub const DEFAULT_RUN_ID: &str = "default";

// OpenCode 端口分配池：每个 tab 独立 OpenCode 子进程需占用独立端口；
// 从 OPENCODE_BASE_PORT 起线性分配，关闭 tab 时释放回池。
pub const OPENCODE_BASE_PORT: u16 = 4096;

#[derive(Default)]
pub struct RuntimeState {
    pub opencode: Mutex<HashMap<String, OpencodeState>>,
    pub codex: Mutex<HashMap<String, CodexAppServerState>>,
    pub claude: Mutex<HashMap<String, ClaudeStreamState>>,
    pub gemini: Mutex<GeminiAcpState>,
    // 多 tab OpenCode 端口池：每个 tab 启动 OpenCode 时从 OPENCODE_BASE_PORT 起分配；
    // 关闭 tab / 子进程时释放回池。
    pub port_pool: Mutex<HashSet<u16>>,
}

pub struct OpencodeState {
    pub child: Option<Child>,
    pub port: u16,
    pub binary: String,
    pub session_id: Option<String>,
    pub managed: bool,
}

impl Default for OpencodeState {
    fn default() -> Self {
        Self {
            child: None,
            port: OPENCODE_BASE_PORT,
            binary: super::DEFAULT_OPENCODE_BINARY.to_string(),
            session_id: None,
            managed: false,
        }
    }
}

#[derive(Default)]
pub struct CodexAppServerState {
    pub client: Option<Arc<CodexAppServerClient>>,
    pub binary: String,
    pub proxy: Option<String>,
}

#[derive(Default)]
pub struct GeminiAcpState {
    pub next_run_id: u64,
    pub active_runs: HashMap<String, Arc<GeminiAcpRun>>,
    pub pending_approvals: HashMap<String, GeminiPendingApproval>,
    pub client: Option<Arc<GeminiAcpRun>>,
}

#[derive(Default)]
pub struct ClaudeStreamState {
    pub client: Option<Arc<ClaudeStreamClient>>,
}

// ---------------------------------------------------------------------------
// CLI 后端客户端结构
// ---------------------------------------------------------------------------

pub struct CodexAppServerClient {
    pub child: Mutex<Child>,
    pub stdin: Mutex<ChildStdin>,
    pub next_request_id: AtomicU64,
    pub pending_responses: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    pub pending_approvals: Arc<Mutex<HashMap<String, CodexPendingApproval>>>,
    pub active_turns: Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    pub thread_streams: Arc<Mutex<HashMap<String, String>>>,
}

pub struct GeminiAcpRun {
    pub child: Mutex<Child>,
    pub stdin: Mutex<ChildStdin>,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub last_message: Arc<Mutex<String>>,
    pub fatal_error: Arc<Mutex<Option<String>>>,
    pub pending_turn: Arc<Mutex<Option<GeminiPendingTurn>>>,
    pub exited: Arc<AtomicBool>,
    pub exit_detail: Arc<Mutex<Option<String>>>,
    pub directory: String,
    pub binary: String,
    pub proxy: Option<String>,
    pub resume_session: Option<String>,
    pub ready_waiter: Arc<Mutex<Option<mpsc::Sender<Result<Option<String>, String>>>>>,
}

pub struct ClaudeStreamClient {
    pub stdin: Mutex<ChildStdin>,
    pub pid: u32,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub last_message: Arc<Mutex<String>>,
    pub fatal_error: Arc<Mutex<Option<String>>>,
    pub pending_turn: Arc<Mutex<Option<ClaudePendingTurn>>>,
    pub exited: Arc<AtomicBool>,
    pub exit_detail: Arc<Mutex<Option<String>>>,
    pub directory: String,
    pub binary: String,
    pub proxy: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume_session: Option<String>,
}

// ---------------------------------------------------------------------------
// 待处理和活跃状态
// ---------------------------------------------------------------------------

pub struct ClaudePendingTurn {
    pub stream_id: Option<String>,
    pub waiter: mpsc::Sender<Result<(Option<String>, String), String>>,
}

#[derive(Clone)]
pub struct CodexPendingApproval {
    pub approval_id: String,
    pub request_id: Value,
    pub request_id_key: String,
    pub method: String,
    pub params: Value,
    pub block: Value,
}

#[derive(Clone)]
pub struct GeminiPendingApproval {
    pub approval_id: String,
    pub run_id: Option<String>,
    pub block: Value,
}

pub struct GeminiPendingTurn {
    pub prompt_id: String,
    pub stream_id: Option<String>,
    pub waiter: mpsc::Sender<Result<(Option<String>, String), String>>,
}

pub struct CodexActiveTurn {
    pub thread_id: String,
    pub working_dir: String,
    pub stream_id: Option<String>,
    pub last_message: String,
    pub command_labels: HashMap<String, String>,
    pub command_outputs: HashMap<String, String>,
    pub todo_text: HashMap<String, String>,
    pub thought_text: HashMap<String, String>,
    pub message_text: HashMap<String, String>,
    pub waiter: Option<mpsc::Sender<Result<String, String>>>,
}

// ---------------------------------------------------------------------------
// API 响应结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopContext {
    pub is_desktop: bool,
    pub node_available: bool,
    pub node_version: Option<String>,
    pub opencode_available: bool,
    pub opencode_version: Option<String>,
    pub opencode_running: bool,
    pub opencode_port: u16,
    pub project_dir: String,
    pub current_session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub running: bool,
    pub managed: bool,
    pub binary: String,
    pub port: u16,
    pub project_dir: String,
    pub session_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeAuthDiagnostic {
    pub status: String,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub log_file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary: String,
    pub logged_in: bool,
    pub login_status: String,
    pub auth_method: Option<String>,
    pub default_model: Option<String>,
    pub default_reasoning_effort: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReasoningLevel {
    pub effort: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub default_reasoning_level: Option<String>,
    pub supported_reasoning_levels: Vec<CodexReasoningLevel>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexVerifyResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRuntimeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary: String,
    pub logged_in: bool,
    pub login_status: String,
    pub auth_method: Option<String>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiModelsResult {
    pub available_models: Vec<GeminiModel>,
    pub current_model_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelsResult {
    pub available_models: Vec<ClaudeModel>,
    pub available_efforts: Vec<String>,
    pub current_model_id: Option<String>,
    pub current_effort: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStreamEvent {
    pub stream_id: String,
    pub backend: String,
    pub channel: String,
    pub line: String,
    // 多标签页路由：前端按 run_id 把事件分发到对应 tab store。
    // 早期发射点尚未填充时为空字符串，前端按 stream_id 兜底匹配。
    #[serde(default)]
    pub run_id: String,
}

pub struct CliLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub display: String,
}

#[derive(Default)]
pub struct GeminiAuthSnapshot {
    pub selected_type: Option<String>,
    pub active_google_account: Option<String>,
    pub has_oauth_creds: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub published_at: Option<String>,
    pub check_error: Option<String>,
}

// ---------------------------------------------------------------------------
// per-tab 运行时访问器：HashMap 路由 + 默认条目自动插入
// ---------------------------------------------------------------------------

fn lock_map<'a, T>(
    mutex: &'a Mutex<HashMap<String, T>>,
    label: &str,
) -> Result<MutexGuard<'a, HashMap<String, T>>, String> {
    mutex
        .lock()
        .map_err(|_| format!("Failed to lock {label} state map."))
}

/// 在指定 run_id 的 OpencodeState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_opencode_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut OpencodeState) -> R,
{
    let mut map = lock_map(&state.opencode, "OpenCode")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(OpencodeState::default);
    Ok(f(entry))
}

/// 在指定 run_id 的 CodexAppServerState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_codex_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut CodexAppServerState) -> R,
{
    let mut map = lock_map(&state.codex, "Codex App Server")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(CodexAppServerState::default);
    Ok(f(entry))
}

/// 在指定 run_id 的 ClaudeStreamState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_claude_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ClaudeStreamState) -> R,
{
    let mut map = lock_map(&state.claude, "Claude Stream")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(ClaudeStreamState::default);
    Ok(f(entry))
}

/// 退出阶段使用：遍历 OpenCode HashMap，对每个条目执行回收闭包。
/// 会阻塞等待 mutex —— 退出时必须拿到锁完成清理，否则会漏杀子进程；
/// mutex 被 poison 照样拿内层继续清理。
pub fn drain_opencode_states<F>(state: &RuntimeState, mut f: F)
where
    F: FnMut(&str, &mut OpencodeState),
{
    let mut map = match state.opencode.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (run_id, run) in map.iter_mut() {
        f(run_id.as_str(), run);
    }
}

pub fn drain_codex_clients(state: &RuntimeState) -> Vec<Arc<CodexAppServerClient>> {
    let mut out = Vec::new();
    let mut map = match state.codex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, codex) in map.iter_mut() {
        if let Some(client) = codex.client.take() {
            out.push(client);
        }
    }
    out
}

/// 为指定 run_id 分配一个 OpenCode 端口。如指定 requested 端口直接使用并占位；
/// 否则从 OPENCODE_BASE_PORT 起线性扫描首个未占用端口。
pub fn allocate_opencode_port(state: &RuntimeState, requested: Option<u16>) -> u16 {
    let mut pool = match state.port_pool.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(port) = requested {
        pool.insert(port);
        return port;
    }
    let mut candidate = OPENCODE_BASE_PORT;
    while pool.contains(&candidate) {
        candidate = candidate.checked_add(1).unwrap_or(OPENCODE_BASE_PORT);
    }
    pool.insert(candidate);
    candidate
}

pub fn release_opencode_port(state: &RuntimeState, port: u16) {
    if let Ok(mut pool) = state.port_pool.lock() {
        pool.remove(&port);
    }
}

pub fn drain_claude_clients(state: &RuntimeState) -> Vec<Arc<ClaudeStreamClient>> {
    let mut out = Vec::new();
    let mut map = match state.claude.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, claude) in map.iter_mut() {
        if let Some(client) = claude.client.take() {
            out.push(client);
        }
    }
    out
}

pub struct MenuLabels {
    pub file: &'static str,
    pub new_design: &'static str,
    pub export_html: &'static str,
    pub export_png: &'static str,
    pub export_svg: &'static str,
    pub export_pdf: &'static str,
    pub export_psd: &'static str,
    pub edit: &'static str,
    pub view: &'static str,
    pub fit_canvas: &'static str,
    pub fullscreen: &'static str,
    pub design: &'static str,
    pub generate: &'static str,
    pub edit_design: &'static str,
    pub window: &'static str,
    pub help: &'static str,
    pub about: &'static str,
    pub check_updates: &'static str,
    pub export: &'static str,
}
