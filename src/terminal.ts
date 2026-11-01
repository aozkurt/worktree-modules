export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
}

export interface Symbols {
  error: string;
  warning: string;
  info: string;
  ok: string;
  bullet: string;
}

export function createStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (text: string) => (color ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
  };
}

export function createSymbols(unicode: boolean): Symbols {
  return unicode
    ? { error: "✖", warning: "▲", info: "●", ok: "✔", bullet: "•" }
    : { error: "x", warning: "!", info: "i", ok: "√", bullet: "*" };
}

/** Colors unless NO_COLOR is set or the output is not a terminal; FORCE_COLOR wins. */
export function wantsColor(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return Boolean(isTTY) && env.TERM !== "dumb";
}

/** Whether the terminal can show ✔ and ✖: anything but the old Windows console. */
export function supportsUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return env.TERM !== "linux";
  return Boolean(
    env.WT_SESSION ||
      env.CI ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === "{cmd::Cmder}" ||
      env.TERM_PROGRAM === "vscode" ||
      env.TERM === "xterm-256color" ||
      env.TERM === "alacritty" ||
      env.TERMINAL_EMULATOR === "JetBrains-JediTerm",
  );
}
