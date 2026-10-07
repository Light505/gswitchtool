export const updater = {
  check: async () => null,
  checkRollback: async () => ({ version: "1.7.0", downloadAndInstall: async () => undefined }),
  relaunch: async () => undefined,
} as typeof import("../src/updater").updater;
export type AvailableUpdate = import("../src/updater").AvailableUpdate;
