use crate::{SerialConfig, SERIAL_READ_TIMEOUT_MS};
use std::{
    io,
    mem::{size_of, zeroed},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};
use windows_sys::Win32::{
    Devices::Communication::{
        GetCommState, SetCommState, SetCommTimeouts, SetupComm, COMMTIMEOUTS, DCB, EVENPARITY,
        NOPARITY, ODDPARITY, ONESTOPBIT, TWOSTOPBITS,
    },
    Foundation::{
        CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, ERROR_IO_INCOMPLETE,
        ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, FALSE, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE, TRUE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED,
        OPEN_EXISTING,
    },
    System::{
        Threading::{CreateEventW, GetCurrentProcess, ResetEvent, WaitForSingleObject},
        IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
    },
};

const SERIAL_IO_WAIT_SLICE_MS: u32 = 5;
const SERIAL_QUEUE_SIZE: u32 = 64 * 1024;

pub struct WindowsSerialPort {
    handle: HANDLE,
    event: HANDLE,
}

unsafe impl Send for WindowsSerialPort {}

impl WindowsSerialPort {
    pub fn write_all(&mut self, bytes: &[u8], stop: &AtomicBool) -> io::Result<()> {
        let mut offset = 0;

        while offset < bytes.len() {
            let written = self.write_once(&bytes[offset..], stop)?;
            if written == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "serial write completed without writing bytes",
                ));
            }
            offset += written;
        }

        Ok(())
    }

    fn open(config: &SerialConfig) -> Result<Self, String> {
        let mut name = Vec::<u16>::new();
        if !config.port_name.starts_with('\\') {
            name.extend(r"\\.\".encode_utf16());
        }
        name.extend(config.port_name.encode_utf16());
        name.push(0);

        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                0,
            )
        };

        if handle == INVALID_HANDLE_VALUE {
            return Err(format!("打开串口失败: {}", last_io_error()));
        }

        let port = Self::from_handle(handle)?;
        let _ = unsafe { SetupComm(port.handle, SERIAL_QUEUE_SIZE, SERIAL_QUEUE_SIZE) };
        configure_port(port.handle, config)?;

        Ok(port)
    }

    fn duplicate(&self) -> Result<Self, String> {
        let process = unsafe { GetCurrentProcess() };
        let mut handle = INVALID_HANDLE_VALUE;

        let duplicated = unsafe {
            DuplicateHandle(
                process,
                self.handle,
                process,
                &mut handle,
                0,
                TRUE,
                DUPLICATE_SAME_ACCESS,
            )
        };

        if duplicated == 0 || handle == INVALID_HANDLE_VALUE {
            return Err(format!("创建串口通道失败: {}", last_io_error()));
        }

        Self::from_handle(handle)
    }

    fn from_handle(handle: HANDLE) -> Result<Self, String> {
        let event = unsafe { CreateEventW(ptr::null_mut(), TRUE, FALSE, ptr::null()) };
        if event == 0 {
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("创建串口异步事件失败: {}", last_io_error()));
        }

        Ok(Self { handle, event })
    }

    fn read_once(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        let mut overlapped = self.prepare_overlapped()?;
        let started = unsafe {
            ReadFile(
                self.handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                ptr::null_mut(),
                &mut overlapped,
            )
        };

        if started == 0 {
            let error = last_error_code();
            if error != ERROR_IO_PENDING {
                return Err(error_from_code(error));
            }
        }

        let transferred = self.wait_for_completion(&mut overlapped, None)?;
        if transferred == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "serial read timed out",
            ));
        }

        Ok(transferred)
    }

    fn write_once(&mut self, bytes: &[u8], stop: &AtomicBool) -> io::Result<usize> {
        let write_len = bytes.len().min(u32::MAX as usize);
        let mut overlapped = self.prepare_overlapped()?;
        let started = unsafe {
            WriteFile(
                self.handle,
                bytes.as_ptr(),
                write_len as u32,
                ptr::null_mut(),
                &mut overlapped,
            )
        };

        if started == 0 {
            let error = last_error_code();
            if error != ERROR_IO_PENDING {
                return Err(error_from_code(error));
            }
        }

        self.wait_for_completion(&mut overlapped, Some(stop))
    }

    fn prepare_overlapped(&self) -> io::Result<OVERLAPPED> {
        if unsafe { ResetEvent(self.event) } == 0 {
            return Err(last_io_error());
        }

        let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
        overlapped.hEvent = self.event;
        Ok(overlapped)
    }

    fn wait_for_completion(
        &self,
        overlapped: &mut OVERLAPPED,
        stop: Option<&AtomicBool>,
    ) -> io::Result<usize> {
        if let Some(transferred) = self.try_finish(overlapped)? {
            return Ok(transferred);
        }

        loop {
            if stop.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                self.cancel_and_wait(overlapped);
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "serial write cancelled",
                ));
            }

            match unsafe { WaitForSingleObject(self.event, SERIAL_IO_WAIT_SLICE_MS) } {
                WAIT_OBJECT_0 => {
                    if let Some(transferred) = self.try_finish(overlapped)? {
                        return Ok(transferred);
                    }
                }
                WAIT_TIMEOUT => {}
                WAIT_FAILED => return Err(last_io_error()),
                _ => return Err(last_io_error()),
            }
        }
    }

    fn try_finish(&self, overlapped: &mut OVERLAPPED) -> io::Result<Option<usize>> {
        let mut transferred = 0_u32;
        let result =
            unsafe { GetOverlappedResult(self.handle, overlapped, &mut transferred, FALSE) };

        if result != 0 {
            return Ok(Some(transferred as usize));
        }

        let error = last_error_code();
        if error == ERROR_IO_INCOMPLETE || error == ERROR_IO_PENDING {
            return Ok(None);
        }
        if error == ERROR_OPERATION_ABORTED {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "serial operation cancelled",
            ));
        }

        Err(error_from_code(error))
    }

    fn cancel_and_wait(&self, overlapped: &mut OVERLAPPED) {
        unsafe {
            CancelIoEx(self.handle, overlapped);
            let mut transferred = 0_u32;
            GetOverlappedResult(self.handle, overlapped, &mut transferred, TRUE);
        }
    }
}

impl io::Read for WindowsSerialPort {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.read_once(buffer)
    }
}

impl Drop for WindowsSerialPort {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.event);
            CloseHandle(self.handle);
        }
    }
}

pub fn open_serial_pair(
    config: &SerialConfig,
) -> Result<(WindowsSerialPort, WindowsSerialPort), String> {
    let writer = WindowsSerialPort::open(config)?;
    let reader = writer.duplicate()?;
    Ok((reader, writer))
}

fn configure_port(handle: HANDLE, config: &SerialConfig) -> Result<(), String> {
    let mut dcb = unsafe { zeroed::<DCB>() };
    dcb.DCBlength = size_of::<DCB>() as u32;

    if unsafe { GetCommState(handle, &mut dcb) } == 0 {
        return Err(format!("读取串口配置失败: {}", last_io_error()));
    }

    init_dcb(&mut dcb);
    dcb.BaudRate = config.baud_rate;
    dcb.ByteSize = config.data_bits;
    dcb.Parity = match config.parity.as_str() {
        "none" => NOPARITY,
        "odd" => ODDPARITY,
        "even" => EVENPARITY,
        _ => return Err(format!("不支持的校验位: {}", config.parity)),
    };
    dcb.StopBits = match config.stop_bits {
        1 => ONESTOPBIT,
        2 => TWOSTOPBITS,
        _ => return Err(format!("不支持的停止位: {}", config.stop_bits)),
    };
    let parity_enabled = dcb.Parity != NOPARITY;
    set_flag(&mut dcb, 1, parity_enabled);
    set_flow_control_none(&mut dcb);

    if unsafe { SetCommState(handle, &dcb) } == 0 {
        return Err(format!("初始化串口配置失败: {}", last_io_error()));
    }

    let timeouts = COMMTIMEOUTS {
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: u32::MAX,
        ReadTotalTimeoutConstant: SERIAL_READ_TIMEOUT_MS as u32,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 0,
    };

    if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
        return Err(format!("初始化串口超时配置失败: {}", last_io_error()));
    }

    Ok(())
}

fn init_dcb(dcb: &mut DCB) {
    dcb.XonChar = 17;
    dcb.XoffChar = 19;
    dcb.ErrorChar = 0;
    dcb.EofChar = 26;
    set_flag(dcb, 0, true);
    set_flag(dcb, 3, false);
    set_two_bit_field(dcb, 4, 0);
    set_flag(dcb, 6, false);
    set_flag(dcb, 10, false);
    set_flag(dcb, 11, false);
    set_flag(dcb, 14, false);
}

fn set_flow_control_none(dcb: &mut DCB) {
    set_flag(dcb, 2, false);
    set_two_bit_field(dcb, 12, 0);
    set_flag(dcb, 8, false);
    set_flag(dcb, 9, false);
}

fn set_flag(dcb: &mut DCB, bit: u32, value: bool) {
    if value {
        dcb._bitfield |= 1 << bit;
    } else {
        dcb._bitfield &= !(1 << bit);
    }
}

fn set_two_bit_field(dcb: &mut DCB, shift: u32, value: u32) {
    dcb._bitfield &= !(0b11 << shift);
    dcb._bitfield |= (value & 0b11) << shift;
}

fn last_error_code() -> u32 {
    unsafe { GetLastError() }
}

fn last_io_error() -> io::Error {
    error_from_code(last_error_code())
}

fn error_from_code(code: u32) -> io::Error {
    io::Error::from_raw_os_error(code as i32)
}
