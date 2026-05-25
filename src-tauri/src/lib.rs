use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const RUNTIME_ADDR: &str = "127.0.0.1:4317";
const RUNTIME_SIDECAR: &str = "apix-runtime";

struct RuntimeSidecar {
    child: Mutex<Option<CommandChild>>,
}

impl RuntimeSidecar {
    fn empty() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    fn new(child: CommandChild) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    fn stop(&self) {
        let child = self.child.lock().ok().and_then(|mut guard| guard.take());

        if let Some(child) = child {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
fn open_file_dialog() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_file()
        .map(|path| path.to_string_lossy().into_owned()))
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![open_file_dialog])
        .setup(|app| {
            let runtime = start_runtime_sidecar(app)?;
            app.manage(runtime);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to run Apix desktop application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(runtime) = app_handle.try_state::<RuntimeSidecar>() {
                runtime.stop();
            }
        }
    });
}

fn start_runtime_sidecar<R: tauri::Runtime>(
    app: &tauri::App<R>,
) -> Result<RuntimeSidecar, Box<dyn std::error::Error>> {
    if runtime_is_healthy() {
        return Ok(RuntimeSidecar::empty());
    }

    let (_rx, child) = app.shell().sidecar(RUNTIME_SIDECAR)?.spawn()?;
    let runtime = RuntimeSidecar::new(child);

    if wait_for_runtime(Duration::from_secs(5)) {
        Ok(runtime)
    } else {
        runtime.stop();
        Err(
            format!("runtime sidecar did not become healthy at http://{RUNTIME_ADDR}/health")
                .into(),
        )
    }
}

fn wait_for_runtime(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if runtime_is_healthy() {
            return true;
        }

        thread::sleep(Duration::from_millis(100));
    }

    false
}

fn runtime_is_healthy() -> bool {
    let Ok(addr) = RUNTIME_ADDR.parse::<SocketAddr>() else {
        return false;
    };

    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(250)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut buffer = [0_u8; 1024];
    let Ok(bytes_read) = stream.read(&mut buffer) else {
        return false;
    };

    let response = String::from_utf8_lossy(&buffer[..bytes_read]);
    response.starts_with("HTTP/1.1 200")
        && response.contains("\"service\":\"apix-runtime\"")
        && response.contains("\"status\":\"ok\"")
}
