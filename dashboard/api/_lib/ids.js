import crypto from "crypto";

export function newId() {
  return crypto.randomUUID();
}

export function now() {
  return new Date();
}
