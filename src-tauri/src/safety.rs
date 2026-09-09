use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SafetyDecision {
    pub allowed: bool,
    pub level: &'static str,
    pub reason: String,
}

pub fn classify(command: &str) -> SafetyDecision {
    let normalized = command.to_ascii_lowercase();

    let blocked_literals = [
        "format-volume",
        "clear-disk",
        "initialize-disk",
        "remove-partition",
        "diskpart",
        "bcdedit",
        "reg delete",
        "stop-computer",
        "restart-computer",
        "disable-computerrestore",
        "cipher /w:",
    ];

    for token in blocked_literals {
        if normalized.contains(token) {
            return SafetyDecision {
                allowed: false,
                level: "red",
                reason: format!("blocked high-risk token: {token}"),
            };
        }
    }

    let recursive_delete = Regex::new(
        r"(?i)\b(remove-item|del|erase|rmdir|rd)\b[^\r\n]*(?:-recurse|/s|/q)"
    ).expect("valid regex");

    if recursive_delete.is_match(command) {
        return SafetyDecision {
            allowed: false,
            level: "red",
            reason: "recursive/bulk deletion requires manual approval".into(),
        };
    }

    let dynamic_execution = [
        "invoke-expression",
        "iex ",
        "downloadstring(",
        "frombase64string(",
    ];

    for token in dynamic_execution {
        if normalized.contains(token) {
            return SafetyDecision {
                allowed: false,
                level: "red",
                reason: format!("dynamic/eval-style execution blocked: {token}"),
            };
        }
    }

    SafetyDecision {
        allowed: true,
        level: "green",
        reason: "no blocked high-risk pattern detected".into(),
    }
}
