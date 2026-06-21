use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

const BACKEND_PORT: u16 = 8765;

struct BackendState {
    child: Mutex<Option<Child>>,
}

impl Drop for BackendState {
    fn drop(&mut self) {
        if let Ok(child_slot) = self.child.get_mut() {
            if let Some(child) = child_slot.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

#[derive(serde::Serialize)]
struct BackendStatus {
    running: bool,
    managed: bool,
    message: String,
}

fn backend_health_ok() -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{BACKEND_PORT}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{BACKEND_PORT}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let _ = stream.shutdown(Shutdown::Write);
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    (response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        && response.contains("EarMasterPro Backend")
}

fn backend_port_has_listener() -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{BACKEND_PORT}").parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn backend_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("backend"))
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|err| format!("Could not locate bundled backend resources: {err}"))?;
        let direct_backend = resource_dir.join("backend");
        if direct_backend.exists() {
            return Ok(direct_backend);
        }
        let bundled_backend = resource_dir.join("_up_").join("backend");
        if bundled_backend.exists() {
            return Ok(bundled_backend);
        }
        Err(format!("Could not find backend folder in {}", resource_dir.display()))
    }
}

fn backend_app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return backend_dir(app);
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|err| format!("Could not locate bundled backend app resources: {err}"))?;
    let direct_backend = resource_dir.join("earmaster-backend");
    if direct_backend.exists() {
        return Ok(direct_backend);
    }
    let bundled_backend = resource_dir.join("_up_").join("build").join("backend-app").join("earmaster-backend");
    if bundled_backend.exists() {
        return Ok(bundled_backend);
    }
    Err(format!("Could not find bundled backend app in {}", resource_dir.display()))
}

fn backend_command(app: &tauri::AppHandle) -> Result<(String, Vec<String>, PathBuf), String> {
    if cfg!(debug_assertions) {
        let dir = backend_dir(app)?;
        let venv_python = dir.join("venv").join("bin").join("python");
        let python = if venv_python.exists() {
            venv_python.to_string_lossy().to_string()
        } else {
            "python3".to_string()
        };
        Ok((python, vec!["main.py".to_string()], dir))
    } else {
        let dir = backend_app_dir(app)?;
        let executable = dir.join("earmaster-backend");
        if !executable.exists() {
            return Err(format!("Bundled backend executable not found at {}", executable.display()));
        }
        Ok((executable.to_string_lossy().to_string(), Vec::new(), dir))
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn refresh_child_status(state: &tauri::State<BackendState>) -> Result<bool, String> {
    let mut child_slot = state.child.lock().map_err(|_| "Backend state lock failed".to_string())?;
    if let Some(child) = child_slot.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(true);
        }
        *child_slot = None;
    }
    Ok(false)
}

fn kill_backend_port() -> Result<(), String> {
    let output = Command::new("lsof")
        .args(["-ti", &format!("tcp:{BACKEND_PORT}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|err| format!("Could not inspect port {BACKEND_PORT}: {err}"))?;
    let pids = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for pid in pids {
        let _ = Command::new("kill").arg(&pid).status();
    }
    for _ in 0..20 {
        if !backend_health_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

#[tauri::command]
fn backend_status(state: tauri::State<BackendState>) -> Result<BackendStatus, String> {
    let managed = refresh_child_status(&state)?;
    let running = backend_health_ok();
    Ok(BackendStatus {
        running,
        managed,
        message: match (running, managed) {
            (true, true) => "Backend is running and managed by Ear Master Pro".to_string(),
            (true, false) => format!("Backend is running on http://localhost:{BACKEND_PORT}"),
            (false, true) => "Backend process is starting, but /health is not responding yet".to_string(),
            (false, false) if backend_port_has_listener() => format!("Port {BACKEND_PORT} is in use, but it is not the EarMasterPro backend"),
            (false, false) => "Backend is not running".to_string(),
        },
    })
}

fn wait_for_backend(message: &str, managed: bool) -> BackendStatus {
    for _ in 0..50 {
        if backend_health_ok() {
            return BackendStatus {
                running: true,
                managed,
                message: message.to_string(),
            };
        }
        thread::sleep(Duration::from_millis(100));
    }
    BackendStatus {
        running: false,
        managed,
        message: "Backend start command was launched, but /health is not responding yet".to_string(),
    }
}

#[tauri::command]
fn start_backend(app: tauri::AppHandle, state: tauri::State<BackendState>) -> Result<BackendStatus, String> {
    let managed = refresh_child_status(&state)?;
    if backend_health_ok() {
        return Ok(BackendStatus {
            running: true,
            managed,
            message: format!("Backend is already responding on http://localhost:{BACKEND_PORT}"),
        });
    }
    if backend_port_has_listener() {
        return Ok(BackendStatus {
            running: false,
            managed: false,
            message: format!("Port {BACKEND_PORT} is already in use by another service. Stop that service or change the EarMasterPro backend port."),
        });
    }

    let mut child_slot = state.child.lock().map_err(|_| "Backend state lock failed".to_string())?;
    if let Some(child) = child_slot.as_mut() {
        if child.try_wait().map_err(|err| err.to_string())?.is_none() {
            return Ok(BackendStatus {
                running: false,
                managed: true,
                message: "Backend process is starting".to_string(),
            });
        }
    }
    *child_slot = None;

    let (program, args, dir) = backend_command(&app)?;
    let child = Command::new(program)
        .args(args)
        .current_dir(&dir)
        .env("PYTHONUNBUFFERED", "1")
        .env("EARMASTER_BACKEND_PORT", BACKEND_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("Could not start backend: {err}"))?;

    *child_slot = Some(child);
    drop(child_slot);

    Ok(wait_for_backend(&format!("Backend started on http://localhost:{BACKEND_PORT}"), true))
}

#[tauri::command]
fn stop_backend(state: tauri::State<BackendState>) -> Result<BackendStatus, String> {
    let mut child_slot = state.child.lock().map_err(|_| "Backend state lock failed".to_string())?;
    if let Some(child) = child_slot.as_mut() {
        let _ = child.kill();
        let _ = child.wait();
        *child_slot = None;
    } else {
        drop(child_slot);
        if backend_health_ok() {
            kill_backend_port()?;
        }
    }

    Ok(BackendStatus {
        running: backend_health_ok(),
        managed: false,
        message: "Backend stopped".to_string(),
    })
}

#[tauri::command]
fn open_backend_terminal(app: tauri::AppHandle, state: tauri::State<BackendState>) -> Result<BackendStatus, String> {
    let managed = refresh_child_status(&state)?;
    if managed {
        stop_backend(state)?;
    }
    if backend_health_ok() {
        return Ok(BackendStatus {
            running: true,
            managed: false,
            message: "Backend is already running. Stop it first to restart it in Terminal.".to_string(),
        });
    }
    if backend_port_has_listener() {
        return Ok(BackendStatus {
            running: false,
            managed: false,
            message: format!("Port {BACKEND_PORT} is already in use by another service. Terminal backend was not started."),
        });
    }

    let (program, args, dir) = backend_command(&app)?;
    let dir_quoted = shell_quote(&dir.to_string_lossy());
    let program_quoted = shell_quote(&program);
    let args_quoted = args.iter().map(|arg| shell_quote(arg)).collect::<Vec<_>>().join(" ");
    let command = format!(
        "cd {dir_quoted}; export EARMASTER_BACKEND_PORT={BACKEND_PORT}; {program_quoted} {args_quoted}; echo; echo 'Backend stopped. You can close this window.'; exec $SHELL"
    );
    let script = format!(
        "tell application \"Terminal\" to do script {}\ntell application \"Terminal\" to activate",
        applescript_string(&command)
    );
    Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map_err(|err| format!("Could not open Terminal: {err}"))?;

    Ok(wait_for_backend(&format!("Backend started in Terminal on http://localhost:{BACKEND_PORT}"), false))
}

#[tauri::command]
fn save_midi_file(default_name: String, bytes: Vec<u8>) -> Result<bool, String> {
    let filename = if default_name.ends_with(".mid") || default_name.ends_with(".midi") {
        default_name
    } else {
        format!("{default_name}.mid")
    };

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "set outputPath to POSIX path of (choose file name with prompt \"Save MIDI file\" default name {})\nreturn outputPath",
            applescript_string(&filename)
        );
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|err| format!("Could not open save dialog: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Ok(false);
            }
            return Err(format!("Save dialog failed: {}", stderr.trim()));
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(false);
        }

        fs::write(&path, bytes).map_err(|err| format!("Could not save MIDI file: {err}"))?;
        Ok(true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = filename;
        let _ = bytes;
        Err("Native MIDI save dialog is not available on this platform.".to_string())
    }
}

#[tauri::command]
fn save_session_file(default_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let filename = if default_name.ends_with(".json") {
        default_name
    } else {
        format!("{default_name}.json")
    };

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "set outputPath to POSIX path of (choose file name with prompt \"Save session file\" default name {})\nreturn outputPath",
            applescript_string(&filename)
        );
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|err| format!("Could not open save dialog: {err}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.contains("User canceled") || stderr.contains("-128") {
                return Ok(String::new());
            }
            return Err(format!("Save dialog failed: {}", stderr.trim()));
        }

        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return Ok(String::new());
        }

        fs::write(&path, bytes).map_err(|err| format!("Could not save session file: {err}"))?;
        Ok(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = filename;
        let _ = bytes;
        Err("Native session save dialog is not available on this platform.".to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .manage(BackendState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![backend_status, start_backend, stop_backend, open_backend_terminal, save_midi_file, save_session_file])
        .run(tauri::generate_context!())
        .expect("error while running Ear Master Pro");
}
