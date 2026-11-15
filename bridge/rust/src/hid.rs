//! HID access through hidapi. One thread per open device: it owns the handle,
//! reports input reports as they arrive, and receives writes over a channel so
//! reads and writes never race on the same handle.

use hidapi::{HidApi, HidDevice};
use std::ffi::CString;
use std::sync::mpsc::{channel, Sender};
use std::thread;

pub const VENDOR_ID: u16 = 0x1915;

#[derive(Clone)]
pub struct DeviceInfo {
    pub id: String,
    pub path: CString,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial_number: String,
    pub usage_page: u16,
    pub usage: u16,
    pub interface: i32,
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let api = match HidApi::new() {
        Ok(api) => api,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<DeviceInfo> = api
        .device_list()
        .filter(|info| info.vendor_id() == VENDOR_ID)
        .filter_map(|info| {
            let path = info.path().to_owned();
            Some(DeviceInfo {
                id: path.to_string_lossy().to_string(),
                path,
                vendor_id: info.vendor_id(),
                product_id: info.product_id(),
                product_name: info.product_string().unwrap_or("").to_string(),
                serial_number: info.serial_number().unwrap_or("").to_string(),
                usage_page: info.usage_page(),
                usage: info.usage(),
                interface: info.interface_number(),
            })
        })
        .collect();
    // Vendor-defined interfaces first: that is where the config protocol lives.
    out.sort_by(|a, b| b.usage_page.cmp(&a.usage_page));
    out
}

pub enum Cmd {
    Write {
        report_id: u8,
        data: Vec<u8>,
        reply: Sender<Result<(), String>>,
    },
    FeatureWrite {
        report_id: u8,
        data: Vec<u8>,
        reply: Sender<Result<Option<Vec<u8>>, String>>,
    },
    FeatureRead {
        report_id: u8,
        reply: Sender<Result<Option<Vec<u8>>, String>>,
    },
    Shutdown {
        reply: Sender<()>,
    },
}

fn prefixed(report_ids: bool, report_id: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 1);
    if report_ids {
        out.push(report_id);
    }
    out.extend_from_slice(data);
    out
}

fn read_feature(device: &HidDevice, report_id: u8) -> Result<Option<Vec<u8>>, String> {
    let mut buffer = vec![0u8; 1024];
    buffer[0] = report_id;
    match device.get_feature_report(&mut buffer) {
        Ok(n) if n > 0 => Ok(Some(buffer[1..n].to_vec())),
        Ok(_) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// Move the device into a worker thread. Returns the command channel.
pub fn spawn<F, G>(
    info: &DeviceInfo,
    report_ids: bool,
    on_input: F,
    on_gone: G,
) -> Result<Sender<Cmd>, String>
where
    F: Fn(Vec<u8>) + Send + 'static,
    G: FnOnce(Option<String>) + Send + 'static,
{
    let api = HidApi::new().map_err(|err| err.to_string())?;
    let device = api.open_path(&info.path).map_err(|err| err.to_string())?;
    let (tx, rx) = channel::<Cmd>();
    let handle_id = info.id.clone();

    thread::spawn(move || {
        let mut buffer = vec![0u8; 1024];
        let mut on_gone = Some(on_gone);
        let mut reason: Option<String> = None;

        'device: loop {
            // Drain queued writes first so a send is never stuck behind a read.
            loop {
                match rx.try_recv() {
                    Ok(Cmd::Write { report_id, data, reply }) => {
                        let buffer = prefixed(report_ids, report_id, &data);
                        let result = device.write(&buffer).map(|_| ()).map_err(|err| err.to_string());
                        if result.is_err() {
                            reason = Some(format!("write failed for {handle_id}"));
                        }
                        let _ = reply.send(result);
                    }
                    Ok(Cmd::FeatureWrite { report_id, data, reply }) => {
                        let buffer = prefixed(report_ids, report_id, &data);
                        let result = device
                            .send_feature_report(&buffer)
                            .map_err(|err| err.to_string())
                            .and_then(|_| read_feature(&device, report_id));
                        let _ = reply.send(result);
                    }
                    Ok(Cmd::FeatureRead { report_id, reply }) => {
                        let _ = reply.send(read_feature(&device, report_id));
                    }
                    Ok(Cmd::Shutdown { reply }) => {
                        let _ = reply.send(());
                        break 'device;
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'device,
                }
            }

            match device.read_timeout(&mut buffer, 8) {
                Ok(0) => {}
                Ok(n) => on_input(buffer[..n].to_vec()),
                Err(err) => {
                    reason = Some(err.to_string());
                    break 'device;
                }
            }
        }

        if let Some(callback) = on_gone.take() {
            callback(reason);
        }
    });

    Ok(tx)
}
