import { vi } from "./vi";

// Mirrors the server limits (server/src/devflow/portal/attachments.ts); the server stays the authority.
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
]);

export type FileLike = { name: string; size: number };

/** Returns a Vietnamese message for the first problem, or null when the selection is acceptable. */
export function checkFiles(files: FileLike[], alreadyAttached = 0): string | null {
  if (files.length + alreadyAttached > MAX_FILES) return vi.files.tooMany;
  for (const file of files) {
    const extension = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.has(extension)) return vi.files.badType;
    if (file.size === 0) return vi.files.empty;
    if (file.size > MAX_FILE_BYTES) return vi.files.tooLarge;
  }
  return null;
}
