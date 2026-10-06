use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};

use atomic_write_file::OpenOptions;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::types::{PendingResetCredit, PendingSwitch, StoredAccount};

pub const STORE_VERSION: u32 = 4;

#[derive(Clone, Serialize, Deserialize)]
pub struct AccountStore {
    #[serde(default = "default_store_version")]
    pub version: u32,
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_switch: Option<PendingSwitch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_reset_credit: Option<PendingResetCredit>,
}

impl Default for AccountStore {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            accounts: Vec::new(),
            active_account_id: None,
            pending_switch: None,
            pending_reset_credit: None,
        }
    }
}

fn default_store_version() -> u32 {
    // Stores written before an explicit version field still contain inline
    // credentials and therefore must pass through the protected-vault
    // migration instead of being mistaken for current metadata.
    0
}

pub fn load(path: &Path) -> Result<AccountStore, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(AccountStore::default()),
        Err(_) => return Err("Unable to read the GSwitch account store".to_string()),
    };

    let store: AccountStore = deserialize(&content, "GSwitch account store")?;
    if store.version > STORE_VERSION {
        return Err("This GSwitch account store was created by a newer version".to_string());
    }
    Ok(store)
}

pub fn save_atomic(path: &Path, store: &AccountStore) -> Result<(), String> {
    // Every successful write upgrades an older compatible store. This keeps
    // migrations explicit without treating an old, valid account library as
    // disposable data.
    let mut current = store.clone();
    current.version = STORE_VERSION;
    let content = serde_json::to_vec_pretty(&current)
        .map_err(|_| "Unable to serialize the GSwitch account store".to_string())?;
    write_private_bytes_atomic(path, &content, "GSwitch account store")
}

/// Moves an unreadable or unsupported GSwitch account library aside before a
/// user-confirmed reset. The recovery directory always sits beside the store,
/// so the move stays on one filesystem. This function never touches Codex's
/// own credentials.
pub fn preserve_damaged_store(path: &Path, recovery_dir: &Path) -> Result<(), String> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("Unable to preserve the damaged GSwitch account store".to_string());
            }
            fs::create_dir_all(recovery_dir)
                .map_err(|_| "Unable to prepare GSwitch recovery storage".to_string())?;
            let preserved = recovery_dir.join(format!("accounts-damaged-{}.json", Uuid::new_v4()));
            fs::rename(path, preserved)
                .map_err(|_| "Unable to preserve the damaged GSwitch account store".to_string())
        }
        // A prior reset attempt may already have moved the damaged file but
        // failed before the fresh empty store was written. Never require the
        // user to recreate or overwrite that preserved source to retry.
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let preserved_exists = fs::read_dir(recovery_dir)
                .ok()
                .and_then(|entries| {
                    entries.flatten().find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with("accounts-damaged-")
                    })
                })
                .is_some();
            if preserved_exists {
                Ok(())
            } else {
                Err(
                    "The damaged GSwitch account store is no longer available to preserve"
                        .to_string(),
                )
            }
        }
        Err(_) => Err("Unable to preserve the damaged GSwitch account store".to_string()),
    }
}

/// Held for the life of the app. The installed and dev builds share one data
/// folder, and each keeps its own in-memory copy of the account store, so only
/// one of them may run at a time.
pub struct AppInstanceLock {
    _file: fs::File,
}

pub enum AppInstance {
    Acquired(AppInstanceLock),
    /// Another build already runs; carries the name it recorded, if readable.
    HeldBy(Option<String>),
}

pub fn acquire_app_instance(data_dir: &Path, name: &str) -> Result<AppInstance, String> {
    use fs2::FileExt;

    fs::create_dir_all(data_dir).map_err(|_| "Unable to prepare GSwitch storage".to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(data_dir.join("app-instance.lock"))
        .map_err(|_| "Unable to open the GSwitch instance lock".to_string())?;
    let name_path = data_dir.join("app-instance.name");
    if file.try_lock_exclusive().is_err() {
        let running = fs::read_to_string(&name_path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        return Ok(AppInstance::HeldBy(running));
    }
    let _ = fs::write(&name_path, name);
    Ok(AppInstance::Acquired(AppInstanceLock { _file: file }))
}

/// Files that belong to one running GSwitch and are never carried over.
const NOT_ADOPTED: &[&str] = &[
    "app-instance.lock",
    "app-instance.name",
    "operations.lock",
    "credentials.lock",
    "invoke-endpoint.json",
    "startup.log",
    "isolated-codex",
];

/// Chooses the data folder, adopting an older one once. `target` is used when
/// it already holds accounts or there is nothing to adopt. Otherwise the older
/// folder's files are copied in, each through a temporary file and the account
/// list last, so a copy that stops early is completed on the next start and
/// never looks finished. The older folder is left as it was. If the copy
/// fails, the older folder stays in use and nothing is lost.
pub fn adopt_data_dir(legacy: &Path, target: &Path) -> std::path::PathBuf {
    let accounts = "accounts.json";
    if target.join(accounts).exists() || !legacy.join(accounts).exists() {
        return target.to_path_buf();
    }
    let copied = copy_tree(legacy, target, true)
        .and_then(|()| copy_file(&legacy.join(accounts), &target.join(accounts)));
    match copied {
        Ok(()) => target.to_path_buf(),
        Err(_) => legacy.to_path_buf(),
    }
}

fn copy_tree(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if top && (NOT_ADOPTED.contains(&name_text.as_ref()) || name_text == "accounts.json") {
            continue;
        }
        // Leftovers of interrupted atomic writes.
        if name_text.contains(".tmp.") {
            continue;
        }
        let destination = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &destination, false)?;
        } else {
            copy_file(&entry.path(), &destination)?;
        }
    }
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let temporary = to.with_file_name(format!(
        "{}.adopting",
        to.file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default()
    ));
    fs::copy(from, &temporary)?;
    // Flushing needs write access on Windows.
    fs::OpenOptions::new()
        .write(true)
        .open(&temporary)?
        .sync_all()?;
    fs::rename(&temporary, to)
}

pub fn read_json(path: &Path, label: &str) -> Result<Value, String> {
    let content = fs::read_to_string(path).map_err(|_| format!("Unable to read {label}"))?;
    deserialize(&content, label)
}

pub fn write_json_atomic(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    let content =
        serde_json::to_vec_pretty(value).map_err(|_| format!("Unable to serialize {label}"))?;
    write_private_bytes_atomic(path, &content, label)
}

pub fn write_private_bytes_atomic(path: &Path, content: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid {label} path"))?;
    fs::create_dir_all(parent).map_err(|_| format!("Unable to create storage for {label}"))?;

    #[cfg(unix)]
    let mut options = OpenOptions::new();

    #[cfg(not(unix))]
    let options = OpenOptions::new();

    #[cfg(unix)]
    {
        use atomic_write_file::unix::OpenOptionsExt as AtomicOpenOptionsExt;
        use std::os::unix::fs::OpenOptionsExt as StdOpenOptionsExt;

        AtomicOpenOptionsExt::preserve_mode(&mut options, false);
        StdOpenOptionsExt::mode(&mut options, 0o600);
    }

    let mut file = options
        .open(path)
        .map_err(|_| format!("Unable to prepare {label} for an atomic write"))?;
    file.write_all(content)
        .map_err(|_| format!("Unable to write {label}"))?;
    file.commit()
        .map_err(|_| format!("Unable to atomically replace {label}"))
}

fn deserialize<T: DeserializeOwned>(content: &str, label: &str) -> Result<T, String> {
    serde_json::from_str(content).map_err(|_| format!("Unable to parse {label}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountIdentity, AccountKind, PendingResetCredit, StoredAccount};
    use serde_json::json;

    #[test]
    fn the_home_data_folder_adopts_the_older_folder_once_and_leaves_it_intact() {
        let root = std::env::temp_dir().join(format!("gswitch-adopt-{}", Uuid::new_v4()));
        let legacy = root.join("appdata");
        let target = root.join("home").join(".gswitchtool");
        fs::create_dir_all(legacy.join("damaged-account-stores")).expect("legacy");
        fs::create_dir_all(legacy.join("isolated-codex")).expect("legacy");
        for (name, content) in [
            ("accounts.json", "accounts"),
            ("credentials.hold", "vault"),
            ("invoke.json", "policy"),
            ("invoke-endpoint.json", "old pipe"),
            ("app-instance.lock", ""),
            ("startup.log", "old start"),
            ("credentials.hold.tmp.1e80", "partial"),
            ("damaged-account-stores/1.json", "kept"),
            ("isolated-codex/config.toml", "scratch"),
        ] {
            fs::write(legacy.join(name), content).expect("write");
        }

        assert_eq!(adopt_data_dir(&legacy, &target), target);
        for (name, content) in [
            ("accounts.json", "accounts"),
            ("credentials.hold", "vault"),
            ("invoke.json", "policy"),
            ("damaged-account-stores/1.json", "kept"),
        ] {
            assert_eq!(fs::read_to_string(target.join(name)).expect(name), content);
        }
        for name in [
            "invoke-endpoint.json",
            "app-instance.lock",
            "startup.log",
            "credentials.hold.tmp.1e80",
            "isolated-codex",
        ] {
            assert!(!target.join(name).exists(), "{name} is not adopted");
        }
        assert_eq!(
            fs::read_to_string(legacy.join("accounts.json")).expect("legacy kept"),
            "accounts"
        );

        // Once adopted, the home folder is authoritative; later changes to
        // the older folder are not copied again.
        fs::write(legacy.join("accounts.json"), "stale").expect("write");
        assert_eq!(adopt_data_dir(&legacy, &target), target);
        assert_eq!(
            fs::read_to_string(target.join("accounts.json")).expect("read"),
            "accounts"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_new_install_starts_in_the_home_folder_and_a_failed_copy_keeps_the_older_folder() {
        let root = std::env::temp_dir().join(format!("gswitch-adopt-{}", Uuid::new_v4()));
        let empty_legacy = root.join("none");
        let target = root.join(".gswitchtool");
        assert_eq!(adopt_data_dir(&empty_legacy, &target), target);

        let legacy = root.join("appdata");
        fs::create_dir_all(&legacy).expect("legacy");
        fs::write(legacy.join("accounts.json"), "accounts").expect("write");
        // A file where the home folder should be makes every copy fail.
        let blocked = root.join("blocked");
        fs::write(&blocked, "not a folder").expect("write");
        assert_eq!(adopt_data_dir(&legacy, &blocked), legacy);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn only_one_build_can_use_the_shared_data_folder_at_a_time() {
        let dir = std::env::temp_dir().join(format!("gswitch-instance-{}", Uuid::new_v4()));
        let first = match acquire_app_instance(&dir, "GSwitch Claude Tool").expect("lock") {
            AppInstance::Acquired(lock) => lock,
            AppInstance::HeldBy(_) => panic!("the first build must get the lock"),
        };
        match acquire_app_instance(&dir, "GSwitch Claude Tool (Dev)").expect("lock") {
            AppInstance::HeldBy(running) => {
                assert_eq!(running.as_deref(), Some("GSwitch Claude Tool"))
            }
            AppInstance::Acquired(_) => panic!("a second build must not run at the same time"),
        }
        drop(first);
        assert!(matches!(
            acquire_app_instance(&dir, "GSwitch Claude Tool (Dev)").expect("lock"),
            AppInstance::Acquired(_)
        ));
        let _ = fs::remove_dir_all(dir);
    }
    use std::{
        env,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_store_path(name: &str) -> std::path::PathBuf {
        let root = env::temp_dir().join(format!(
            "gswitch-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        root.join("accounts.json")
    }

    fn account(id: &str, credential: Value) -> StoredAccount {
        StoredAccount {
            id: id.into(),
            label: "Personal".into(),
            kind: AccountKind::ChatGpt,
            email: Some("user@example.com".into()),
            plan_type: Some("pro".into()),
            workspace_name: Some("Personal".into()),
            account_structure: Some("workspace".into()),
            identity: Some(AccountIdentity::ChatGpt {
                user_id: "user".into(),
                workspace_id: Some("workspace".into()),
            }),
            quota: None,
            reset_credits: None,
            credential_ref: "account:test".into(),
            credential_generation: 1,
            needs_apply: false,
            sign_in_required: false,
            invoke_allowed: false,
            credential,
        }
    }

    #[test]
    fn metadata_store_never_serializes_complete_credential_documents() {
        let path = temp_store_path("roundtrip");
        let credential = json!({
            "tokens": {"access_token": "secret", "refresh_token": "rotate-me"},
            "auth_mode": "chatgpt",
            "future_field": {"preserve": true}
        });
        let store = AccountStore {
            version: STORE_VERSION,
            accounts: vec![account("one", credential.clone())],
            active_account_id: None,
            pending_switch: None,
            pending_reset_credit: None,
        };

        save_atomic(&path, &store).expect("save");
        let metadata = fs::read_to_string(&path).expect("metadata");
        assert!(!metadata.contains("secret"));
        assert!(!metadata.contains("rotate-me"));
        assert!(!metadata.contains("future_field"));
        let loaded = load(&path).expect("load");
        assert_eq!(loaded.accounts[0].credential, Value::Null);
        assert_eq!(loaded.accounts[0].credential_ref, "account:test");

        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn replaces_existing_store() {
        let path = temp_store_path("replace");

        save_atomic(&path, &AccountStore::default()).expect("first save");

        let replacement = AccountStore {
            version: STORE_VERSION,
            accounts: vec![account("two", json!({"tokens": {"access_token": "new"}}))],
            active_account_id: None,
            pending_switch: None,
            pending_reset_credit: None,
        };
        save_atomic(&path, &replacement).expect("replacement save");

        let loaded = load(&path).expect("load replacement");
        assert_eq!(loaded.accounts.len(), 1);
        assert_eq!(loaded.accounts[0].id, "two");

        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn loads_accounts_saved_before_identity_and_version_existed() {
        let path = temp_store_path("legacy-metadata");
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(
            &path,
            r#"{
                "accounts": [{
                    "id": "legacy",
                    "label": "Legacy",
                    "kind": "chat_gpt",
                    "credential": {"tokens": {"access_token": "secret"}}
                }]
            }"#,
        )
        .expect("write legacy store");

        let loaded = load(&path).expect("load legacy store");
        assert_eq!(loaded.version, 0);
        assert_eq!(loaded.accounts.len(), 1);
        assert_eq!(loaded.accounts[0].identity, None);
        assert_eq!(loaded.accounts[0].quota, None);

        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn a_compatible_old_store_is_upgraded_on_the_next_atomic_write() {
        let path = temp_store_path("upgrade-on-write");
        let store = AccountStore {
            version: 2,
            accounts: vec![account("one", json!({"token": "old"}))],
            active_account_id: None,
            pending_switch: None,
            pending_reset_credit: None,
        };

        save_atomic(&path, &store).expect("save");
        assert_eq!(load(&path).expect("load").version, STORE_VERSION);
        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn metadata_store_keeps_only_pending_reset_references() {
        let path = temp_store_path("pending-reset-credit");
        let store = AccountStore {
            version: STORE_VERSION,
            accounts: vec![account("one", json!({"token": "current"}))],
            active_account_id: None,
            pending_switch: None,
            pending_reset_credit: Some(PendingResetCredit {
                account_id: "one".into(),
                secret_ref: Some("pending-reset-credit:test".into()),
                secret_generation: 1,
                credit_id: "provider-private-id".into(),
                idempotency_key: "7e6dff14-928a-4593-846a-5cae9cf0f9c9".into(),
                created_at_unix_ms: 123,
                discard_allowed: false,
            }),
        };

        save_atomic(&path, &store).expect("save");
        let metadata = fs::read_to_string(&path).expect("metadata");
        assert!(!metadata.contains("provider-private-id"));
        assert!(!metadata.contains("7e6dff14-928a-4593-846a-5cae9cf0f9c9"));
        let pending = load(&path)
            .expect("load")
            .pending_reset_credit
            .expect("pending reset credit");
        assert_eq!(pending.account_id, "one");
        assert_eq!(
            pending.secret_ref.as_deref(),
            Some("pending-reset-credit:test")
        );
        assert!(pending.credit_id.is_empty());
        assert!(pending.idempotency_key.is_empty());

        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }

    #[test]
    fn parse_errors_do_not_include_credential_contents() {
        let path = temp_store_path("parse-error");
        fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
        fs::write(&path, "{ secret-token").expect("write malformed store");

        let error = match load(&path) {
            Ok(_) => panic!("must reject malformed store"),
            Err(error) => error,
        };
        assert_eq!(error, "Unable to parse GSwitch account store");
        assert!(!error.contains("secret-token"));

        let _ = fs::remove_dir_all(path.parent().expect("parent"));
    }
}
