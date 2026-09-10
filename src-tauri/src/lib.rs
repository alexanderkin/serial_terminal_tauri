use serde::{Deserialize, Serialize};
use serialport::{DataBits, Parity, SerialPort, StopBits};
use std::{
    io::{ErrorKind, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct SerialManager {
    inner: Mutex<SerialState>,
}

#[derive(Default)]
struct SerialState {
    port: Option<Box<dyn SerialPort>>,
    reader_stop: Option<Arc<AtomicBool>>,
    reader: Option<JoinHandle<()>>,
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
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|error| format!("打开串口失败: {error}"))?;

    let reader_port = port
        .try_clone()
        .map_err(|error| format!("创建串口读取通道失败: {error}"))?;

    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    let reader_stop = Arc::new(AtomicBool::new(false));
    let reader_handle = spawn_reader(app, reader_port, Arc::clone(&reader_stop));

    state.port = Some(port);
    state.reader_stop = Some(reader_stop);
    state.reader = Some(reader_handle);
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
    let mut state = manager
        .inner
        .lock()
        .map_err(|_| "串口状态锁已损坏".to_string())?;
    let bytes = text.as_bytes();
    let port = state
        .port
        .as_mut()
        .ok_or_else(|| "串口未连接".to_string())?;

    port.write_all(bytes)
        .map_err(|error| format!("写入串口失败: {error}"))?;
    port.flush()
        .map_err(|error| format!("刷新串口输出失败: {error}"))?;
    state.tx_bytes += bytes.len() as u64;

    Ok(state.tx_bytes)
}

fn spawn_reader(
    app: AppHandle,
    mut port: Box<dyn SerialPort>,
    reader_stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];

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

fn close_locked(state: &mut SerialState) {
    if let Some(reader_stop) = state.reader_stop.take() {
        reader_stop.store(true, Ordering::Relaxed);
    }

    state.port.take();

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialManager::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_ports, connect, disconnect, write_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
