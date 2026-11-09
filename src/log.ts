export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`warn: ${m}`),
  error: (m) => console.error(`error: ${m}`),
};
