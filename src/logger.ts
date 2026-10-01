/**
 * 极简日志。刻意不引 chalk / pino：
 * CLI 的输出要么给人看（终端、带色），要么给机器看（`--json`），
 * 这两种需求都不需要日志框架。
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code: string, s: string): string => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const color = {
  dim: (s: string) => paint('2', s),
  red: (s: string) => paint('31', s),
  green: (s: string) => paint('32', s),
  yellow: (s: string) => paint('33', s),
  blue: (s: string) => paint('34', s),
  bold: (s: string) => paint('1', s),
};

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
  /** 结构化输出的透传口；`--json` 时人类可读日志走 stderr */
  json?: boolean;
}

class ConsoleLogger implements Logger {
  constructor(
    private readonly verbose: boolean,
    readonly json: boolean,
  ) {}

  private emit(stream: NodeJS.WriteStream, msg: string): void {
    // `--json` 模式下，人类可读的日志必须走 stderr，
    // 否则会污染 stdout 上给调用方解析的 JSON。
    stream.write(`${msg}\n`);
  }

  info(msg: string): void {
    if (this.json) process.stderr.write(`${msg}\n`);
    else this.emit(process.stdout, msg);
  }

  warn(msg: string): void {
    this.emit(process.stderr, color.yellow(msg));
  }

  error(msg: string): void {
    this.emit(process.stderr, color.red(msg));
  }

  debug(msg: string): void {
    if (this.verbose) this.emit(process.stderr, color.dim(msg));
  }
}

export function createLogger(opts: { verbose?: boolean; json?: boolean } = {}): Logger {
  return new ConsoleLogger(opts.verbose ?? false, opts.json ?? false);
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
