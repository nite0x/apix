#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct Runtime {
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
    exited: AtomicBool,
}

// Retain the directories used by the browser developer entry and the previous
// Windows desktop launcher, including the adjacent credentials key.
fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("APIX_DB_PATH").filter(|p| !p.is_empty()) {
        return Ok(std::path::absolute(path)?);
    }
    #[cfg(windows)]
    let directory = app.path().local_data_dir()?.join("Apix").join("data");
    #[cfg(not(windows))]
    let directory = app.path().data_dir()?.join("dev.apix.desktop");
    Ok(directory.join("apix.db"))
}

fn ready_url(line: &[u8]) -> Option<tauri::Url> {
    let message: serde_json::Value = serde_json::from_slice(line).ok()?;
    if message["type"] != "ready" {
        return None;
    }
    let url = tauri::Url::parse(message["url"].as_str()?).ok()?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() != Some(0)
        && url.path() == "/"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none())
    .then_some(url)
}

fn fail(app: &tauri::AppHandle, message: String) {
    eprintln!("{message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("Apix 启动失败")
        .show(move |_| handle.exit(1));
}

fn start(app: &tauri::AppHandle, runtime: Arc<Runtime>) -> Result<(), Box<dyn std::error::Error>> {
    let address = std::env::var("APIX_ADDR").unwrap_or_else(|_| "127.0.0.1:4319".into());
    let socket: std::net::SocketAddr = address.parse()?;
    if socket.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) {
        return Err("桌面 APIX_ADDR 必须为 127.0.0.1:<端口>，0 表示动态端口".into());
    }
    let database = database_path(app)?;
    let directory = database.parent().ok_or("数据库路径无父目录")?;
    let mut directories = fs::DirBuilder::new();
    directories.recursive(true);
    #[cfg(unix)]
    directories.mode(0o700);
    directories.create(directory)?;
    let log_path = directory.join("startup.log");
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut log = options.open(&log_path)?;
    writeln!(log, "\nApix desktop starting")?;
    let command = app
        .shell()
        .sidecar("apix-runtime")?
        .current_dir(directory)
        .env("APIX_DESKTOP_SIDECAR", "1")
        .env("APIX_ADDR", address)
        .env("APIX_DB_PATH", &database)
        .env("APIX_LOG_PATH", directory.join("runtime.log"));
    #[cfg(windows)]
    let command = command.env(
        "APIX_EXECUTOR_DIR",
        app.path().resource_dir()?.join("executors"),
    );
    let (mut events, child) = command.spawn()?;
    *runtime.child.lock().unwrap() = Some(child);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut ready = false;
        let mut failed = false;
        loop {
            let event = if ready {
                events.recv().await
            } else {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
                        failed = true;
                        ready = true;
                        if let Some(child) = runtime.child.lock().unwrap().as_mut() {
                            let _ = child.write(b"shutdown\n");
                        }
                        fail(
                            &app,
                            format!("后端未能在 30 秒内就绪。日志：{}", log_path.display()),
                        );
                        // Keep draining output and receiving the exit event while
                        // the error dialog is visible, so cleanup cannot block.
                        continue;
                    }
                }
            };
            match event {
                Some(CommandEvent::Stdout(line)) if !ready => {
                    if let Some(url) = ready_url(&line) {
                        ready = true;
                        if runtime.stopping.load(Ordering::SeqCst) {
                            continue;
                        }
                        if let Some(window) = app.get_webview_window("main") {
                            if let Err(error) = window.navigate(url) {
                                fail(&app, format!("无法加载工作台：{error}"));
                                failed = true;
                                if let Some(child) = runtime.child.lock().unwrap().as_mut() {
                                    let _ = child.write(b"shutdown\n");
                                }
                            }
                        }
                    }
                }
                Some(CommandEvent::Stderr(line)) => {
                    let _ = writeln!(log, "{}", String::from_utf8_lossy(&line));
                }
                Some(CommandEvent::Terminated(status)) => {
                    runtime.child.lock().unwrap().take();
                    runtime.exited.store(true, Ordering::SeqCst);
                    if !failed && !runtime.stopping.load(Ordering::SeqCst) {
                        fail(
                            &app,
                            format!(
                                "后端已退出（代码 {:?}）。日志：{}",
                                status.code,
                                log_path.display()
                            ),
                        );
                    }
                    return;
                }
                Some(CommandEvent::Error(error)) => {
                    let _ = writeln!(log, "{error}");
                }
                None => {
                    if !runtime.stopping.load(Ordering::SeqCst) {
                        fail(&app, "后端控制连接已关闭".into());
                    }
                    return;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn shutdown(app: &tauri::AppHandle, runtime: Arc<Runtime>, code: i32) {
    if runtime.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(child) = runtime.child.lock().unwrap().as_mut() {
            let _ = child.write(b"shutdown\n");
        }
        let deadline = Instant::now() + Duration::from_secs(35);
        while !runtime.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
            if runtime.child.lock().unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(child) = runtime.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        runtime.exited.store(true, Ordering::SeqCst);
        app.exit(code);
    });
}

fn main() {
    let runtime = Arc::new(Runtime::default());
    let state = runtime.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            if let Err(error) = start(app.handle(), state.clone()) {
                fail(app.handle(), error.to_string());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("无法创建 Apix 桌面应用");
    app.run(move |app, event| match event {
        RunEvent::ExitRequested { api, code, .. } if !runtime.exited.load(Ordering::SeqCst) => {
            api.prevent_exit();
            shutdown(app, runtime.clone(), code.unwrap_or(0));
        }
        RunEvent::Exit => {
            // Last-resort cleanup; graceful shutdown normally consumed the child.
            if let Some(child) = runtime.child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::ready_url;
    #[test]
    fn readiness_accepts_only_local_runtime_urls() {
        assert!(ready_url(br#"{"type":"ready","url":"http://127.0.0.1:4319/"}"#).is_some());
        for url in [
            "https://example.com/",
            "http://127.0.0.1:0/",
            "http://127.0.0.1:4319/other",
            "http://user@127.0.0.1:4319/",
        ] {
            let message = serde_json::json!({"type": "ready", "url": url});
            assert!(ready_url(message.to_string().as_bytes()).is_none());
        }
    }
}
