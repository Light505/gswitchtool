use std::path::{Path, PathBuf};

#[cfg(test)]
const INSTALLED_IDENTIFIER: &str = "com.light505.gswitchtool";

pub fn is_dev_identifier(identifier: &str) -> bool {
    identifier.ends_with(".dev")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildIdentity {
    pub dev: bool,
    pub data_dir: PathBuf,
    pub codex_home: PathBuf,
    pub vault_service: &'static str,
}

impl BuildIdentity {
    pub fn from_identifier(identifier: &str, home: &Path) -> Self {
        let dev = is_dev_identifier(identifier);
        Self {
            dev,
            data_dir: home.join(if dev {
                ".gswitchtool-dev"
            } else {
                ".gswitchtool"
            }),
            codex_home: home.join(if dev { ".codex-dev" } else { ".codex" }),
            vault_service: if dev {
                "gswitchtool credential vault (Dev)"
            } else {
                "gswitchtool credential vault"
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_selects_isolated_dev_paths_and_vault() {
        let home = Path::new("C:/Users/test");
        let installed = BuildIdentity::from_identifier(INSTALLED_IDENTIFIER, home);
        assert!(!installed.dev);
        assert_eq!(installed.data_dir, home.join(".gswitchtool"));
        assert_eq!(installed.codex_home, home.join(".codex"));
        assert_eq!(installed.vault_service, "gswitchtool credential vault");

        let dev = BuildIdentity::from_identifier("com.light505.gswitchtool.dev", home);
        assert!(dev.dev);
        assert_eq!(dev.data_dir, home.join(".gswitchtool-dev"));
        assert_eq!(dev.codex_home, home.join(".codex-dev"));
        assert_eq!(dev.vault_service, "gswitchtool credential vault (Dev)");
    }
}
