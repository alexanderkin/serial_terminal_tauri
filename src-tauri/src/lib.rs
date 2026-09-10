use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use std::{
    collections::BTreeSet,
    io::{ErrorKind, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

const SERIAL_READ_BUFFER_SIZE: usize = 4 * 1024;
const SERIAL_READ_TIMEOUT_MS: u64 = 5;

#[derive(Default)]
struct SerialManager {
    inner: Mutex<SerialState>,
}

#[derive(Default)]
struct SerialState {
    reader_stop: Option<Arc<AtomicBool>>,
    reader: Option<JoinHandle<()>>,
    writer_tx: Option<mpsc::Sender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
    tx_bytes: u64,
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
    data: Vec<u8>,
    byte_count: u64,
}

#[derive(Clone, Debug, Serialize)]
struct SerialError {
    message: String,
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
    let data_bits = map_data_bits(config.data_bits)?;
    let parity = map_parity(&config.parity)?;
    let stop_bits = map_stop_bits(config.stop_bits)?;

    {
        let mut state = manager
            .inner
            .lock()
            .map_err(|_| "串口状态锁已损坏".to_string())?;
        close_locked(&mut state);
    }

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

    let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>();
    let reader_stop = Arc::new(AtomicBool::new(false));
    let reader_handle = spawn_reader(app.clone(), reader_port, Arc::clone(&reader_stop));
    let writer_handle = spawn_writer(app, port, writer_rx);

    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    state.reader_stop = Some(reader_stop);
    state.reader = Some(reader_handle);
    state.writer_tx = Some(writer_tx);
    state.writer = Some(writer_handle);
    state.tx_bytes = 0;

    Ok(())
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
fn write_text(manager: State<'_, SerialManager>, text: String) -> Result<u64, String> {
    let bytes = text.into_bytes();
    let byte_count = bytes.len() as u64;
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    let writer_tx = state
        .writer_tx
        .as_ref()
        .ok_or_else(|| "串口未连接".to_string())?;

    writer_tx
        .send(bytes)
        .map_err(|_| "串口写入通道已关闭".to_string())?;
    state.tx_bytes += byte_count;

    Ok(state.tx_bytes)
}

fn spawn_reader(
    app: AppHandle,
    mut port: Box<dyn SerialPort>,
    reader_stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; SERIAL_READ_BUFFER_SIZE];

        while !reader_stop.load(Ordering::Relaxed) {
            match port.read(&mut buffer) {
                Ok(0) => {}
                Ok(byte_count) => {
                    let payload = SerialData {
                        data: buffer[..byte_count].to_vec(),
                        byte_count: byte_count as u64,
                    };
                    let _ = app.emit("serial-data", payload);
                }
                Err(error) if error.kind() == ErrorKind::TimedOut => {}
                Err(error) => {
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

fn spawn_writer(
    app: AppHandle,
    mut port: Box<dyn SerialPort>,
    writer_rx: mpsc::Receiver<Vec<u8>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        while let Ok(bytes) = writer_rx.recv() {
            if bytes.is_empty() {
                continue;
            }

            if let Err(error) = port.write_all(&bytes) {
                let _ = app.emit(
                    "serial-error",
                    SerialError {
                        message: format!("串口写入失败: {error}"),
                    },
                );
                break;
            }
        }
    })
}

fn close_locked(state: &mut SerialState) {
    if let Some(reader_stop) = state.reader_stop.take() {
        reader_stop.store(true, Ordering::Relaxed);
    }

    state.writer_tx.take();

    if let Some(writer) = state.writer.take() {
        let _ = writer.join();
    }

    if let Some(reader) = state.reader.take() {
        let _ = reader.join();
    }

    state.tx_bytes = 0;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_fonts, list_ports, connect, disconnect, write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
