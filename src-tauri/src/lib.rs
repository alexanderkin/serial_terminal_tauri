use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use std::{
    collections::{BTreeSet, HashMap},
    env,
    io::{ErrorKind, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
mod windows_serial;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const SERIAL_READ_BUFFER_SIZE: usize = 4 * 1024;
const SERIAL_READ_TIMEOUT_MS: u64 = 5;
const SERIAL_EMIT_INTERVAL_MS: u64 = 2;
const SERIAL_EMIT_BUFFER_LIMIT: usize = 4 * 1024;
const SERIAL_WRITE_BUFFER_LIMIT: usize = 256;
const SERIAL_PERF_WARN_MS: u128 = 25;

#[derive(Default)]
struct SerialManager {
    inner: Mutex<SerialState>,
}

#[derive(Default)]
struct SerialState {
    reader_stop: Option<Arc<AtomicBool>>,
    reader: Option<JoinHandle<()>>,
    writer_stop: Option<Arc<AtomicBool>>,
    writer_tx: Option<mpsc::Sender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
}

struct AndroidManager {
    scrcpy_processes: Mutex<HashMap<String, Child>>,
    adb_shells: Arc<Mutex<HashMap<String, AdbShellHandle>>>,
    next_adb_shell_id: AtomicU64,
}

impl Default for AndroidManager {
    fn default() -> Self {
        Self {
            scrcpy_processes: Mutex::new(HashMap::new()),
            adb_shells: Arc::new(Mutex::new(HashMap::new())),
            next_adb_shell_id: AtomicU64::new(1),
        }
    }
}

struct AdbShellHandle {
    shell_id: u64,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Child>>,
}

impl Drop for AndroidManager {
    fn drop(&mut self) {
        if let Ok(processes) = self.scrcpy_processes.get_mut() {
            stop_all_scrcpy_locked(processes);
        }
        if let Ok(mut shells) = self.adb_shells.lock() {
            stop_all_adb_shells_locked(&mut shells);
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
struct SerialConfig {
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
}

#[derive(Clone, Debug, Serialize)]
struct SerialData {
    data: String,
    byte_count: u64,
}

#[derive(Clone, Debug, Serialize)]
struct SerialError {
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct AdbCommandResult {
    address: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct AdbDevice {
    id: String,
    state: String,
    is_remote: bool,
}

#[derive(Clone, Debug, Serialize)]
struct AndroidState {
    devices: Vec<AdbDevice>,
    scrcpy_devices: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ScrcpyOptions {
    video_codec: String,
    video_bit_rate: String,
}

#[derive(Clone, Debug, Serialize)]
struct AdbShellData {
    device_id: String,
    shell_id: u64,
    data: String,
    byte_count: u64,
}

#[derive(Clone, Debug, Serialize)]
struct AdbShellExit {
    device_id: String,
    shell_id: u64,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
struct AdbShellStart {
    device_id: String,
    shell_id: u64,
}

#[tauri::command]
fn list_fonts() -> Result<Vec<String>, String> {
    Ok(enumerate_fonts())
}

#[tauri::command]
fn list_ports() -> Result<Vec<String>, String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|port| port.port_name).collect())
        .map_err(|error| format!("枚举串口失败: {error}"))
}

#[tauri::command]
fn connect(
    app: AppHandle,
    manager: State<'_, SerialManager>,
    config: SerialConfig,
) -> Result<(), String> {
    validate_serial_config(&config)?;

    {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_string())?;
        close_locked(&mut state);
    }

    #[cfg(windows)]
    let (reader_port, writer_port) = windows_serial::open_serial_pair(&config)?;

    #[cfg(not(windows))]
    let (reader_port, writer_port) = open_serial_pair(&config)?;

    let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>();
    let writer_stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::new(AtomicBool::new(false));
    let reader_handle = spawn_reader(app.clone(), reader_port, Arc::clone(&reader_stop));
    let writer_handle = spawn_writer(app, writer_port, writer_rx, Arc::clone(&writer_stop));

    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    state.reader_stop = Some(reader_stop);
    state.reader = Some(reader_handle);
    state.writer_stop = Some(writer_stop);
    state.writer_tx = Some(writer_tx);
    state.writer = Some(writer_handle);

    Ok(())
}

#[cfg(not(windows))]
fn open_serial_pair(
    config: &SerialConfig,
) -> Result<(Box<dyn SerialPort>, Box<dyn SerialPort>), String> {
    let data_bits = map_data_bits(config.data_bits)?;
    let parity = map_parity(&config.parity)?;
    let stop_bits = map_stop_bits(config.stop_bits)?;

    let port = serialport::new(&config.port_name, config.baud_rate)
        .data_bits(data_bits)
        .parity(parity)
        .stop_bits(stop_bits)
        .timeout(Duration::from_millis(SERIAL_READ_TIMEOUT_MS))
        .open()
        .map_err(|error| format!("打开串口失败: {error}"))?;

    let reader_port = port
        .try_clone()
        .map_err(|error| format!("创建串口读取通道失败: {error}"))?;

    Ok((reader_port, port))
}

#[tauri::command]
fn disconnect(manager: State<'_, SerialManager>) -> Result<(), String> {
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    close_locked(&mut state);
    Ok(())
}

#[tauri::command]
fn write_text(manager: State<'_, SerialManager>, text: String) -> Result<(), String> {
    let bytes = text.into_bytes();
    let writer_tx = {
        let state = manager
            .inner
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_string())?;
        state
            .writer_tx
            .as_ref()
            .cloned()
            .ok_or_else(|| "串口未连接".to_string())?
    };

    writer_tx
        .send(bytes)
        .map_err(|_| "串口写入通道已关闭".to_string())?;

    Ok(())
}

#[tauri::command]
fn report_perf(message: String) {
    eprintln!("[serial-terminal perf] {message}");
}

#[tauri::command]
fn adb_connect(address: String) -> Result<AdbCommandResult, String> {
    let address = normalize_adb_address(&address)?;
    let message = run_adb_command(&["connect", &address])?;

    if is_adb_connect_failure(&message) {
        return Err(format!(
            "ADB 连接失败: {}",
            fallback_command_message(&message)
        ));
    }

    Ok(AdbCommandResult { address, message })
}

#[tauri::command]
fn adb_disconnect(address: String) -> Result<AdbCommandResult, String> {
    let address = normalize_adb_address(&address)?;
    let message = run_adb_command(&["disconnect", &address])?;
    Ok(AdbCommandResult { address, message })
}

#[tauri::command]
fn list_adb_state(manager: State<'_, AndroidManager>) -> Result<AndroidState, String> {
    let output = run_adb_command(&["devices"])?;
    let devices = parse_adb_devices(&output);
    let scrcpy_devices = {
        let mut processes = manager
            .scrcpy_processes
            .lock()
            .map_err(|_| "scrcpy 状态锁已损坏".to_string())?;
        cleanup_scrcpy_locked(&mut processes);
        scrcpy_devices_locked(&processes)
    };

    Ok(AndroidState {
        devices,
        scrcpy_devices,
    })
}

#[tauri::command]
fn list_scrcpy_devices(manager: State<'_, AndroidManager>) -> Result<Vec<String>, String> {
    let mut processes = manager
        .scrcpy_processes
        .lock()
        .map_err(|_| "scrcpy 状态锁已损坏".to_string())?;
    cleanup_scrcpy_locked(&mut processes);
    Ok(scrcpy_devices_locked(&processes))
}

#[tauri::command]
fn start_scrcpy(
    manager: State<'_, AndroidManager>,
    device_id: String,
    options: ScrcpyOptions,
) -> Result<(), String> {
    let device_id = normalize_device_id(&device_id)?;
    let options = normalize_scrcpy_options(options)?;

    {
        let mut processes = manager
            .scrcpy_processes
            .lock()
            .map_err(|_| "scrcpy 状态锁已损坏".to_string())?;
        cleanup_scrcpy_locked(&mut processes);
        if processes.contains_key(&device_id) {
            return Ok(());
        }
    }

    let scrcpy_path = find_tool_path("scrcpy")?;
    let mut command = Command::new(&scrcpy_path);
    if let Some(scrcpy_dir) = scrcpy_path.parent() {
        command.current_dir(scrcpy_dir);
    }
    command
        .arg("-s")
        .arg(&device_id)
        .arg(format!("--video-codec={}", options.video_codec))
        .arg(format!("--video-bit-rate={}", options.video_bit_rate));
    hide_command_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "启动 scrcpy 失败: {error} ({})",
            scrcpy_path.to_string_lossy()
        )
    })?;

    thread::sleep(Duration::from_millis(150));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!("scrcpy 启动后立即退出: {status}"));
    }

    let mut processes = manager
        .scrcpy_processes
        .lock()
        .map_err(|_| "scrcpy 状态锁已损坏".to_string())?;
    cleanup_scrcpy_locked(&mut processes);
    processes.insert(device_id, child);

    Ok(())
}

#[tauri::command]
fn stop_scrcpy(manager: State<'_, AndroidManager>, device_id: String) -> Result<(), String> {
    let device_id = normalize_device_id(&device_id)?;
    let mut processes = manager
        .scrcpy_processes
        .lock()
        .map_err(|_| "scrcpy 状态锁已损坏".to_string())?;
    cleanup_scrcpy_locked(&mut processes);

    if let Some(mut child) = processes.remove(&device_id) {
        let _ = child.kill();
        let _ = child.wait();
    }

    Ok(())
}

#[tauri::command]
fn start_adb_shell(
    app: AppHandle,
    manager: State<'_, AndroidManager>,
    device_id: String,
) -> Result<AdbShellStart, String> {
    let device_id = normalize_device_id(&device_id)?;
    let shells = Arc::clone(&manager.adb_shells);

    {
        let mut sessions = shells
            .lock()
            .map_err(|_| "ADB Shell 状态锁已损坏".to_string())?;
        cleanup_adb_shells_locked(&mut sessions);
        if let Some(handle) = sessions.get(&device_id) {
            return Ok(AdbShellStart {
                device_id,
                shell_id: handle.shell_id,
            });
        }
    }

    let adb_path = find_tool_path("adb")?;
    let mut command = Command::new(&adb_path);
    if let Some(adb_dir) = adb_path.parent() {
        command.current_dir(adb_dir);
    }
    command
        .arg("-s")
        .arg(&device_id)
        .arg("shell")
        .arg("-tt")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_command_window(&mut command);

    let mut child = command.spawn().map_err(|error| {
        format!(
            "启动 ADB Shell 失败: {error} ({})",
            adb_path.to_string_lossy()
        )
    })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "创建 ADB Shell 输入通道失败".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "创建 ADB Shell 输出通道失败".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "创建 ADB Shell 错误输出通道失败".to_string())?;

    let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>();
    let stop = Arc::new(AtomicBool::new(false));
    let shell_id = manager.next_adb_shell_id.fetch_add(1, Ordering::Relaxed);
    let child = Arc::new(Mutex::new(child));
    let handle = AdbShellHandle {
        shell_id,
        stdin_tx,
        stop: Arc::clone(&stop),
        child: Arc::clone(&child),
    };

    {
        let mut sessions = shells
            .lock()
            .map_err(|_| "ADB Shell 状态锁已损坏".to_string())?;
        sessions.insert(device_id.clone(), handle);
    }

    spawn_adb_shell_writer(stdin, stdin_rx, Arc::clone(&stop));
    spawn_adb_shell_reader(app.clone(), device_id.clone(), shell_id, stdout);
    spawn_adb_shell_reader(app.clone(), device_id.clone(), shell_id, stderr);
    spawn_adb_shell_monitor(app, shells, device_id.clone(), shell_id, child, stop);

    Ok(AdbShellStart {
        device_id,
        shell_id,
    })
}

#[tauri::command]
fn write_adb_shell(
    manager: State<'_, AndroidManager>,
    device_id: String,
    text: String,
) -> Result<(), String> {
    let device_id = normalize_device_id(&device_id)?;
    if text.is_empty() {
        return Ok(());
    }

    let sessions = manager
        .adb_shells
        .lock()
        .map_err(|_| "ADB Shell 状态锁已损坏".to_string())?;
    let handle = sessions
        .get(&device_id)
        .ok_or_else(|| format!("ADB Shell 未打开: {device_id}"))?;
    if handle.stop.load(Ordering::Relaxed) {
        return Err(format!("ADB Shell 已关闭: {device_id}"));
    }

    handle
        .stdin_tx
        .send(text.into_bytes())
        .map_err(|_| format!("ADB Shell 输入通道已关闭: {device_id}"))
}

#[tauri::command]
fn stop_adb_shell(manager: State<'_, AndroidManager>, device_id: String) -> Result<(), String> {
    let device_id = normalize_device_id(&device_id)?;
    let handle = {
        let mut sessions = manager
            .adb_shells
            .lock()
            .map_err(|_| "ADB Shell 状态锁已损坏".to_string())?;
        cleanup_adb_shells_locked(&mut sessions);
        sessions.remove(&device_id)
    };

    if let Some(handle) = handle {
        stop_adb_shell_handle(&handle);
    }

    Ok(())
}

fn spawn_adb_shell_writer(
    mut stdin: ChildStdin,
    stdin_rx: mpsc::Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
) {
    let _ = thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let Ok(bytes) = stdin_rx.recv() else {
                break;
            };

            if bytes.is_empty() {
                continue;
            }

            if stdin.write_all(&bytes).is_err() {
                stop.store(true, Ordering::Relaxed);
                break;
            }

            if stdin.flush().is_err() {
                stop.store(true, Ordering::Relaxed);
                break;
            }
        }
    });
}

fn spawn_adb_shell_reader<R>(app: AppHandle, device_id: String, shell_id: u64, mut reader: R)
where
    R: Read + Send + 'static,
{
    let _ = thread::spawn(move || {
        let mut buffer = [0_u8; SERIAL_READ_BUFFER_SIZE];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(byte_count) => {
                    emit_adb_shell_data(&app, &device_id, shell_id, &buffer[..byte_count]);
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}

fn spawn_adb_shell_monitor(
    app: AppHandle,
    sessions: Arc<Mutex<HashMap<String, AdbShellHandle>>>,
    device_id: String,
    shell_id: u64,
    child: Arc<Mutex<Child>>,
    stop: Arc<AtomicBool>,
) {
    let _ = thread::spawn(move || {
        let mut stopped_by_request = false;
        let message = loop {
            if stop.load(Ordering::Relaxed) {
                stopped_by_request = true;
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                }
            }

            let status = match child.lock() {
                Ok(mut child) => child.try_wait(),
                Err(_) => break "ADB Shell 状态锁已损坏".to_string(),
            };

            match status {
                Ok(Some(status)) => {
                    if stopped_by_request || stop.load(Ordering::Relaxed) {
                        break "ADB Shell 已关闭".to_string();
                    }
                    break format!("ADB Shell 已退出: {status}");
                }
                Ok(None) => thread::sleep(Duration::from_millis(150)),
                Err(error) => break format!("ADB Shell 状态检查失败: {error}"),
            }
        };

        stop.store(true, Ordering::Relaxed);
        if let Ok(mut sessions) = sessions.lock() {
            if sessions
                .get(&device_id)
                .is_some_and(|handle| handle.shell_id == shell_id)
            {
                sessions.remove(&device_id);
            }
        }
        let _ = app.emit(
            "adb-shell-exit",
            AdbShellExit {
                device_id,
                shell_id,
                message,
            },
        );
    });
}

fn emit_adb_shell_data(app: &AppHandle, device_id: &str, shell_id: u64, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }

    let _ = app.emit(
        "adb-shell-data",
        AdbShellData {
            device_id: device_id.to_string(),
            shell_id,
            data: BASE64_STANDARD.encode(bytes),
            byte_count: bytes.len() as u64,
        },
    );
}

fn spawn_reader<R>(app: AppHandle, mut port: R, reader_stop: Arc<AtomicBool>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0_u8; SERIAL_READ_BUFFER_SIZE];
        let mut pending = Vec::with_capacity(SERIAL_READ_BUFFER_SIZE);
        let mut last_emit = Instant::now();

        while !reader_stop.load(Ordering::Relaxed) {
            match port.read(&mut buffer) {
                Ok(0) => {}
                Ok(byte_count) => {
                    pending.extend_from_slice(&buffer[..byte_count]);
                    if pending.len() >= SERIAL_EMIT_BUFFER_LIMIT
                        || last_emit.elapsed() >= Duration::from_millis(SERIAL_EMIT_INTERVAL_MS)
                    {
                        emit_serial_data(&app, &mut pending);
                        last_emit = Instant::now();
                    }
                }
                Err(error) if error.kind() == ErrorKind::TimedOut => {
                    if !pending.is_empty() {
                        emit_serial_data(&app, &mut pending);
                        last_emit = Instant::now();
                    }
                }
                Err(error) => {
                    if !pending.is_empty() {
                        emit_serial_data(&app, &mut pending);
                    }
                    let _ = app.emit(
                        "serial-error",
                        SerialError {
                            message: format!("串口读取失败: {error}"),
                        },
                    );
                    break;
                }
            }
        }
    })
}

trait SerialWriterPort: Send + 'static {
    fn write_all_serial(&mut self, bytes: &[u8], stop: &AtomicBool) -> std::io::Result<()>;
}

impl SerialWriterPort for Box<dyn SerialPort> {
    fn write_all_serial(&mut self, bytes: &[u8], _stop: &AtomicBool) -> std::io::Result<()> {
        self.write_all(bytes)
    }
}

#[cfg(windows)]
impl SerialWriterPort for windows_serial::WindowsSerialPort {
    fn write_all_serial(&mut self, bytes: &[u8], stop: &AtomicBool) -> std::io::Result<()> {
        self.write_all(bytes, stop)
    }
}

fn spawn_writer<W>(
    app: AppHandle,
    mut port: W,
    writer_rx: mpsc::Receiver<Vec<u8>>,
    writer_stop: Arc<AtomicBool>,
) -> JoinHandle<()>
where
    W: SerialWriterPort,
{
    thread::spawn(move || {
        while !writer_stop.load(Ordering::Relaxed) {
            let Ok(mut bytes) = writer_rx.recv() else {
                break;
            };

            if bytes.is_empty() {
                continue;
            }

            let packets = drain_serial_writer_queue(&writer_rx, &mut bytes);
            let start = Instant::now();
            if let Err(error) = port.write_all_serial(&bytes, &writer_stop) {
                if writer_stop.load(Ordering::Relaxed) && error.kind() == ErrorKind::Interrupted {
                    break;
                }

                let _ = app.emit(
                    "serial-error",
                    SerialError {
                        message: format!("串口写入失败: {error}"),
                    },
                );
                break;
            }

            let elapsed = start.elapsed();
            if elapsed.as_millis() > SERIAL_PERF_WARN_MS {
                eprintln!(
                    "[serial-terminal perf] serial write completed in {}ms, bytes={}, packets={}",
                    elapsed.as_millis(),
                    bytes.len(),
                    packets
                );
            }
        }
    })
}

fn drain_serial_writer_queue(writer_rx: &mpsc::Receiver<Vec<u8>>, pending: &mut Vec<u8>) -> usize {
    let mut packets = 1;

    while pending.len() < SERIAL_WRITE_BUFFER_LIMIT {
        match writer_rx.try_recv() {
            Ok(bytes) => {
                if bytes.is_empty() {
                    continue;
                }
                pending.extend_from_slice(&bytes);
                packets += 1;
            }
            Err(mpsc::TryRecvError::Empty) => break,
            Err(mpsc::TryRecvError::Disconnected) => break,
        }
    }

    packets
}

fn emit_serial_data(app: &AppHandle, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }

    let start = Instant::now();
    let byte_count = pending.len() as u64;
    let payload = SerialData {
        data: BASE64_STANDARD.encode(pending.as_slice()),
        byte_count,
    };
    let _ = app.emit("serial-data", payload);
    let elapsed = start.elapsed();

    if elapsed.as_millis() > SERIAL_PERF_WARN_MS {
        eprintln!(
            "[serial-terminal perf] serial-data emit took {}ms, bytes={}",
            elapsed.as_millis(),
            byte_count
        );
    }

    pending.clear();
}

fn close_locked(state: &mut SerialState) {
    if let Some(reader_stop) = state.reader_stop.take() {
        reader_stop.store(true, Ordering::Relaxed);
    }

    if let Some(writer_stop) = state.writer_stop.take() {
        writer_stop.store(true, Ordering::Relaxed);
    }

    state.writer_tx.take();

    if let Some(writer) = state.writer.take() {
        let _ = writer.join();
    }

    if let Some(reader) = state.reader.take() {
        let _ = reader.join();
    }
}

fn validate_serial_config(config: &SerialConfig) -> Result<(), String> {
    map_data_bits(config.data_bits)?;
    map_parity(&config.parity)?;
    map_stop_bits(config.stop_bits)?;
    Ok(())
}

fn map_data_bits(value: u8) -> Result<DataBits, String> {
    match value {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(format!("不支持的数据位: {value}")),
    }
}

fn map_parity(value: &str) -> Result<Parity, String> {
    match value {
        "none" => Ok(Parity::None),
        "even" => Ok(Parity::Even),
        "odd" => Ok(Parity::Odd),
        _ => Err(format!("不支持的校验位: {value}")),
    }
}

fn map_stop_bits(value: u8) -> Result<StopBits, String> {
    match value {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(format!("不支持的停止位: {value}")),
    }
}

#[cfg(windows)]
fn enumerate_fonts() -> Vec<String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
        RegKey,
    };

    let mut fonts = default_fonts();
    let registry_paths = [
        (
            HKEY_LOCAL_MACHINE,
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
        ),
        (
            HKEY_CURRENT_USER,
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
        ),
    ];

    for (root, path) in registry_paths {
        let key = RegKey::predef(root);
        if let Ok(fonts_key) = key.open_subkey_with_flags(path, KEY_READ) {
            for value in fonts_key.enum_values().flatten() {
                for family in font_families_from_registry_name(&value.0) {
                    fonts.insert(family);
                }
            }
        }
    }

    fonts.into_iter().collect()
}

#[cfg(not(windows))]
fn enumerate_fonts() -> Vec<String> {
    default_fonts().into_iter().collect()
}

fn default_fonts() -> BTreeSet<String> {
    [
        "Cascadia Mono",
        "Cascadia Code",
        "Consolas",
        "JetBrains Mono",
        "JetBrainsMonoNerdFontMono-Regular",
        "Microsoft YaHei UI",
        "Microsoft YaHei",
        "SimHei",
        "monospace",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn font_families_from_registry_name(name: &str) -> Vec<String> {
    let base = name.split(" (").next().unwrap_or(name);
    base.split(" & ")
        .flat_map(|part| {
            part.split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .filter(|value| !value.starts_with('@'))
        .map(str::to_string)
        .collect()
}

fn normalize_adb_address(address: &str) -> Result<String, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("请输入远程 ADB 地址".to_string());
    }

    let address = trimmed.strip_prefix("tcp://").unwrap_or(trimmed);
    if address.contains(':') {
        Ok(address.to_string())
    } else {
        Ok(format!("{address}:5555"))
    }
}

fn normalize_device_id(device_id: &str) -> Result<String, String> {
    let trimmed = device_id.trim();
    if trimmed.is_empty() {
        return Err("请选择一个 ADB 设备".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_scrcpy_options(options: ScrcpyOptions) -> Result<ScrcpyOptions, String> {
    let video_codec = options.video_codec.trim().to_ascii_lowercase();
    if !matches!(video_codec.as_str(), "h264" | "h265" | "av1") {
        return Err(format!("不支持的视频编码: {}", options.video_codec));
    }

    let video_bit_rate = options.video_bit_rate.trim().to_string();
    if video_bit_rate.is_empty() {
        return Err("请输入 scrcpy 视频码率".to_string());
    }

    if video_bit_rate.len() > 16
        || !video_bit_rate
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '.')
    {
        return Err("scrcpy 视频码率只支持数字、字母和小数点，例如 8M".to_string());
    }

    Ok(ScrcpyOptions {
        video_codec,
        video_bit_rate,
    })
}

fn run_adb_command(args: &[&str]) -> Result<String, String> {
    let adb_path = find_tool_path("adb")?;
    let mut command = Command::new(&adb_path);
    if let Some(adb_dir) = adb_path.parent() {
        command.current_dir(adb_dir);
    }
    command.args(args);
    hide_command_window(&mut command);

    let output = command
        .output()
        .map_err(|error| format!("执行 adb 失败: {error} ({})", adb_path.to_string_lossy()))?;
    let message = command_output_text(&output);

    if !output.status.success() {
        return Err(format!(
            "adb 执行失败: {}",
            fallback_command_message(&message)
        ));
    }

    Ok(message)
}

fn parse_adb_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('*')
                || trimmed.eq_ignore_ascii_case("List of devices attached")
            {
                return None;
            }

            let mut parts = trimmed.split_whitespace();
            let id = parts.next()?.to_string();
            let state = parts.next().unwrap_or("unknown").to_string();

            Some(AdbDevice {
                is_remote: id.contains(':'),
                id,
                state,
            })
        })
        .collect()
}

fn is_adb_connect_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("failed")
        || lower.contains("unable")
        || lower.contains("cannot")
        || lower.contains("refused")
        || lower.contains("no route")
}

fn find_tool_path(tool: &str) -> Result<PathBuf, String> {
    let filename = tool_filename(tool);

    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let candidate = exe_dir.join(&filename);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    if let Some(path_value) = env::var_os("PATH") {
        for path in env::split_paths(&path_value) {
            let candidate = path.join(&filename);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Err(format!(
        "未找到 {filename}，请将它放到程序同级目录，或加入系统 PATH"
    ))
}

fn tool_filename(tool: &str) -> String {
    if cfg!(windows) {
        format!("{tool}.exe")
    } else {
        tool.to_string()
    }
}

#[cfg(windows)]
fn hide_command_window(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_command_window(_command: &mut Command) {}

fn command_output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn fallback_command_message(message: &str) -> String {
    if message.trim().is_empty() {
        "没有输出".to_string()
    } else {
        message.trim().to_string()
    }
}

fn cleanup_scrcpy_locked(processes: &mut HashMap<String, Child>) {
    processes.retain(|_, child| match child.try_wait() {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(_) => false,
    });
}

fn scrcpy_devices_locked(processes: &HashMap<String, Child>) -> Vec<String> {
    let mut devices = processes.keys().cloned().collect::<Vec<_>>();
    devices.sort();
    devices
}

fn stop_all_scrcpy_locked(processes: &mut HashMap<String, Child>) {
    for child in processes.values_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
    processes.clear();
}

fn cleanup_adb_shells_locked(sessions: &mut HashMap<String, AdbShellHandle>) {
    sessions.retain(|_, handle| {
        if handle.stop.load(Ordering::Relaxed) {
            return false;
        }

        match handle.child.lock() {
            Ok(mut child) => matches!(child.try_wait(), Ok(None)),
            Err(_) => false,
        }
    });
}

fn stop_adb_shell_handle(handle: &AdbShellHandle) {
    handle.stop.store(true, Ordering::Relaxed);
    if let Ok(mut child) = handle.child.lock() {
        let _ = child.kill();
    }
}

fn stop_all_adb_shells_locked(sessions: &mut HashMap<String, AdbShellHandle>) {
    for handle in sessions.values() {
        stop_adb_shell_handle(handle);
    }
    sessions.clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialManager::default())
        .manage(AndroidManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_fonts,
            list_ports,
            connect,
            disconnect,
            write_text,
            report_perf,
            adb_connect,
            adb_disconnect,
            list_adb_state,
            list_scrcpy_devices,
            start_scrcpy,
            stop_scrcpy,
            start_adb_shell,
            write_adb_shell,
            stop_adb_shell
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
