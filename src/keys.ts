export function toTableKey(value: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error("Table key source value cannot be empty.");
  }

  return Buffer.from(value, "utf8")
    .toString("base64url");
}
