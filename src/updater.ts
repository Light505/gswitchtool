import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

// Keep the native updater boundary small and mockable. Rust finds, downloads,
// and verifies signed releases; the GitHub sign-in it uses never reaches the
// window, and no installer payload crosses the account-management API.
export type UpdateProgressEvent = DownloadEvent;

export interface AvailableUpdate {
  version: string;
  downloadAndInstall: (onEvent?: (event: UpdateProgressEvent) => void) => Promise<void>;
}

interface AppUpdateView {
  version: string;
  notes: string | null;
}

// Modified by Light505: updates and rollback share the signed native install path.
async function check(command: "check_app_update" | "check_app_rollback"): Promise<AvailableUpdate | null> {
  const found = await invoke<AppUpdateView | null>(command);
  if (!found) {
    return null;
  }
  return {
    version: found.version,
    downloadAndInstall: (onEvent) => {
      const onEventChannel = new Channel<UpdateProgressEvent>();
      onEventChannel.onmessage = (event) => onEvent?.(event);
      return invoke<void>("install_app_update", { version: found.version, onEvent: onEventChannel });
    },
  };
}

export const updater = {
  check: () => check("check_app_update"),
  checkRollback: () => check("check_app_rollback"),
  relaunch,
};
