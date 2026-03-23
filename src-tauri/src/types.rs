// 应用级类型定义 — 运行时状态、API 响应结构、CLI 后端客户端

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

// ---------------------------------------------------------------------------
// 核心运行时状态（Tauri managed state）
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct RuntimeState {
    pub opencode: Mutex<OpencodeState>,
    pub codex: Mutex<CodexAppServerState>,
    pub claude: Mutex<ClaudeStreamState>,
    pub gemini: Mutex<GeminiAcpState>,
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
            port: 4096,
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
