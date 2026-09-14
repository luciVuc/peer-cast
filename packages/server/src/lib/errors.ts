/** A typed error that maps to an HTTP status + optional machine code. */
export class AppError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string, code?: string) =>
  new AppError(400, msg, code);
export const unauthorized = (msg = "unauthorized", code?: string) =>
  new AppError(401, msg, code);
export const forbidden = (msg = "forbidden", code?: string) =>
  new AppError(403, msg, code);
export const notFound = (msg = "not found", code?: string) =>
  new AppError(404, msg, code);
export const conflict = (msg: string, code?: string) =>
  new AppError(409, msg, code);
