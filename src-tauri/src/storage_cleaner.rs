use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SCAN_FILES: usize = 15000;
const MAX_SCAN_DIRECTORIES: usize = 3500;
const MAX_RETURN_CANDIDATES: usize = 300;
const MAX_BROWSE_ENTRIES: usize = 200;

#[derive(Serialize)]
pub struct StorageDrive {
    path: String,
    label: String,
}

#[derive(Serialize)]
pub struct StorageEntry {
    name: String,
    path: String,
    is_directory: bool,
    bytes: u64,
}

#[derive(Serialize)]
pub struct StorageListing {
    path: String,
    entries: Vec<StorageEntry>,
    truncated: bool,
}

#[derive(Serialize)]
pub struct StorageCandidate {
    path: String,
    name: String,
    bytes: u64,
    reason: String,
}

#[derive(Serialize)]
pub struct StorageScan {
    root: String,
    files_scanned: usize,
    directories_scanned: usize,
    scanned_bytes: u64,
    candidate_count: usize,
    candidate_bytes: u64,
    candidates: Vec<StorageCandidate>,
    truncated: bool,
    skipped_links: usize,
    read_errors: usize,
}

fn canonical_directory(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();

    if path.is_empty() {
        return Err("Select a folder first".into());
    }

    let canonical = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("Cannot open folder: {e}"))?;

    if !canonical.is_dir() {
        return Err("The selected path is not a directory".into());
    }

    Ok(canonical)
}

fn is_reparse_point(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return true;
    };

    if meta.file_type().is_symlink() {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }

    false
}

fn candidate_reason(
    path: &Path,
    inside_temp: bool
) -> Option<&'static str> {
    if inside_temp {
        return Some(
            "Located under the selected Windows temp directory; review before removal"
        );
    }

    let ext = path.extension()?.to_str()?.to_ascii_lowercase();

    match ext.as_str() {
        "tmp" | "temp" => Some(
            "Temporary file extension; verify the file is no longer needed"
        ),
        "log" => Some(
            "Log file; may be needed for diagnostics or development"
        ),
        "dmp" | "mdmp" => Some(
            "Crash dump; may be useful for troubleshooting"
        ),
        _ => None,
    }
}

#[tauri::command]
pub fn storage_drives() -> Result<Vec<StorageDrive>, String> {
    let mut drives = Vec::new();

    for letter in b'A'..=b'Z' {
        let letter = letter as char;
        let path = format!("{letter}:\\");
        if Path::new(&path).is_dir() {
            drives.push(StorageDrive {
                path,
                label: format!("Drive {letter}:"),
            });
        }
    }

    Ok(drives)
}

#[tauri::command]
pub async fn storage_list_directory(
    path: String
) -> Result<StorageListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_directory(&path)?;
        let mut entries = Vec::new();
        let mut truncated = false;

        for item in fs::read_dir(&root)
            .map_err(|e| format!("Cannot list directory: {e}"))?
        {
            if entries.len() >= MAX_BROWSE_ENTRIES {
                truncated = true;
                break;
            }

            let Ok(item) = item else { continue };
            let item_path = item.path();

            if is_reparse_point(&item_path) {
                continue;
            }

            let Ok(meta) = fs::symlink_metadata(&item_path) else {
                continue;
            };

            entries.push(StorageEntry {
                name: item.file_name().to_string_lossy().to_string(),
                path: item_path.to_string_lossy().to_string(),
                is_directory: meta.is_dir(),
                bytes: if meta.is_file() { meta.len() } else { 0 },
            });
        }

        entries.sort_by(|a, b| {
            b.is_directory.cmp(&a.is_directory).then_with(|| {
                a.name.to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
        });

        Ok(StorageListing {
            path: root.to_string_lossy().to_string(),
            entries,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("Directory task failed: {e}"))?
}

#[tauri::command]
pub async fn storage_scan_folder(
    path: String
) -> Result<StorageScan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonical_directory(&path)?;
        let temp = std::env::temp_dir().canonicalize().ok();

        let inside_temp = temp
            .as_ref()
            .map(|t| root.starts_with(t))
            .unwrap_or(false);

        let mut stack = vec![root.clone()];
        let mut result = StorageScan {
            root: root.to_string_lossy().to_string(),
            files_scanned: 0,
            directories_scanned: 0,
            scanned_bytes: 0,
            candidate_count: 0,
            candidate_bytes: 0,
            candidates: Vec::new(),
            truncated: false,
            skipped_links: 0,
            read_errors: 0,
        };

        'scan: while let Some(dir) = stack.pop() {
            if result.directories_scanned >= MAX_SCAN_DIRECTORIES {
                result.truncated = true;
                break;
            }

            result.directories_scanned += 1;

            let Ok(read_dir) = fs::read_dir(&dir) else {
                result.read_errors += 1;
                continue;
            };

            for item in read_dir {
                let Ok(item) = item else {
                    result.read_errors += 1;
                    continue;
                };

                let path = item.path();

                if is_reparse_point(&path) {
                    result.skipped_links += 1;
                    continue;
                }

                let Ok(meta) = fs::symlink_metadata(&path) else {
                    result.read_errors += 1;
                    continue;
                };

                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }

                if !meta.is_file() {
                    continue;
                }

                if result.files_scanned >= MAX_SCAN_FILES {
                    result.truncated = true;
                    break 'scan;
                }

                result.files_scanned += 1;
                result.scanned_bytes =
                    result.scanned_bytes.saturating_add(meta.len());

                if let Some(reason) =
                    candidate_reason(&path, inside_temp)
                {
                    result.candidate_count += 1;
                    result.candidate_bytes =
                        result.candidate_bytes.saturating_add(meta.len());

                    if result.candidates.len() < MAX_RETURN_CANDIDATES {
                        result.candidates.push(StorageCandidate {
                            name: item.file_name().to_string_lossy().to_string(),
                            path: path.to_string_lossy().to_string(),
                            bytes: meta.len(),
                            reason: reason.to_string(),
                        });
                    }
                }
            }
        }

        result.candidates.sort_by(|a, b| b.bytes.cmp(&a.bytes));

        Ok(result)
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_temporary_files() {
        assert!(candidate_reason(Path::new("example.tmp"), false).is_some());
    }

    #[test]
    fn does_not_classify_project_assets_as_trash() {
        assert!(candidate_reason(Path::new("world.uasset"), false).is_none());
        assert!(candidate_reason(Path::new("game1.cpp"), false).is_none());
    }
}
