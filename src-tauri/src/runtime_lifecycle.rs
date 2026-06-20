// 跨 runtime 的进程生命周期编排。
//
// 这里的函数不属于任何单个 runtime —— 它们在应用退出 / 启动时统一收割
// opencode / codex / claude 派生的子进程与孤儿进程，避免子孙被 launchd 收养成残留。
// （纯进程工具 kill_child_descendants 住在 utils.rs，这里只做跨 runtime 的编排。）

use crate::claude::kill_claude_stream_client;
use crate::types::*;
use crate::utils::*;
use std::collections::BTreeSet;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Manager};

// 应用退出时的总清理入口：依次停掉各 runtime 的子进程，再兜底扫一遍孤儿。
pub fn shutdown_runtime_children(app: &AppHandle) {
    let state = app.state::<RuntimeState>();

    // 退出阶段必须拿到锁完成清理，try_lock 拿不到就跳过是漏杀子进程的主因。
    // 多 tab 模式下遍历每个 run_id 各自的 OpencodeState，逐一杀掉子进程并收集端口。
    let runtime: &RuntimeState = state.inner();
    let mut opencode_ports: Vec<u16> = Vec::new();
    drain_opencode_states(runtime, |_run_id, opencode| {
        if let Some(child) = opencode.child.as_mut() {
            // 先递归杀 opencode 派生的子孙（node MCP servers、shell 工具等），
            // 再杀主进程。缺了这一步 grandchildren 会被 launchd 收养变残留
            kill_child_descendants(child.id());
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

    // 最后兜底：遍历我们进程的所有直系子进程（包括未进 state 的 warmup / 初始化
    // 残留等），递归杀整棵子树。退出前杀掉，否则它们在我们死后会被 launchd 收养成
    // ppid==1 孤儿，而那时已没人能扫它们。
    kill_all_direct_children();

    // 再扫一次 ppid==1 孤儿（上轮崩溃 / 强退留下的可能还在）
    cleanup_stale_runtime_orphans(app);
}

// 启动时把上一轮崩溃 / 强退留下的 runtime 孤儿全部收割掉。
// 识别已解析的 opencode / codex / claude 原生二进制路径：只要 ppid == 1
// （被 launchd 收养 = 我们死了它还活着）且 command 命中其一，就递归杀进程树。
#[cfg(unix)]
pub fn cleanup_stale_runtime_orphans(app: &AppHandle) {
    use crate::utils::{resolve_claude_binary, resolve_codex_binary, resolve_opencode_binary};

    let opencode_marker = resolve_opencode_binary(app, None)
        .to_string_lossy()
        .to_string();
    let codex_marker = resolve_codex_binary(app, None).to_string_lossy().to_string();
    let claude_marker = resolve_claude_binary(app, None).to_string_lossy().to_string();

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
        // ps 列之间是变长空白，不能用 splitn(whitespace) —— 那样相邻的空白
        // 会被当成空字段，把 ppid 和 command 糊到一起。手动切两刀。
        let line = raw_line.trim_start();
        let (pid_text, rest) = match line.find(char::is_whitespace) {
            Some(idx) => (&line[..idx], line[idx..].trim_start()),
            None => continue,
        };
        let (ppid_text, command) = match rest.find(char::is_whitespace) {
            Some(idx) => (&rest[..idx], rest[idx..].trim_start()),
            None => continue,
        };

        let Ok(pid) = pid_text.parse::<u32>() else {
            continue;
        };
        let Ok(ppid) = ppid_text.parse::<u32>() else {
            continue;
        };
        if pid == current_pid || ppid != 1 {
            continue;
        }

        // 原生二进制孤儿：opencode / codex / claude（用完整 staged 路径，精确）
        let hits_native = command.contains(&opencode_marker)
            || command.contains(&codex_marker)
            || command.contains(&claude_marker);

        if hits_native {
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
pub fn cleanup_stale_runtime_orphans(_app: &AppHandle) {}

#[cfg(unix)]
fn kill_all_direct_children() {
    let current_pid = std::process::id();
    let output = match Command::new("pgrep")
        .arg("-P")
        .arg(current_pid.to_string())
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
    let children: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();

    for child in &children {
        kill_child_descendants(*child);
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(child.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    std::thread::sleep(Duration::from_millis(120));
    for child in &children {
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(child.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(unix))]
fn kill_all_direct_children() {
    // Windows: taskkill /PID <self> /T /F 会连带把子进程都杀了，但我们不能杀自己。
    // 换思路：遍历 Get-CimInstance 找 ParentProcessId == self 的进程逐个 taskkill
    let current_pid = std::process::id();
    let script = format!(
        "Get-CimInstance Win32_Process -Filter \"ParentProcessId={}\" | ForEach-Object {{ $_.ProcessId }}",
        current_pid
    );
    let mut ps = Command::new("powershell.exe");
    configure_background_command(&mut ps);
    let Ok(output) = ps
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for pid in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
    {
        let mut tk = Command::new("taskkill");
        configure_background_command(&mut tk);
        let _ = tk
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
