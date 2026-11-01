export { ConfigError, loadConfig, type Config } from "./config.js";
export { doctor, type DoctorOptions } from "./doctor.js";
export { CommandError } from "./model.js";
export type {
  DoctorResult,
  FolderReport,
  FolderResult,
  InstallResult,
  Note,
  NoteCode,
  RemoveResult,
  Severity,
  ShareResult,
  UnlinkResult,
  WorktreeReport,
} from "./model.js";
export { remove, type RemoveOptions } from "./remove.js";
export { add, link, unlink, type AddOptions, type LinkOptions } from "./share.js";
