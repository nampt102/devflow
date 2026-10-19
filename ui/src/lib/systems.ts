// Pure helpers for the DevFlow "Systems" page. The server and the database check the same rules; these only
// tell the staff member what is wrong before they submit.

export const SYSTEM_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DOCS_PATH = /^[A-Za-z0-9._/ -]{0,200}$/;

/** "Cổng HR Portal" becomes "cong-hr-portal": the suggested key until the staff member types their own. */
export function suggestKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export type SystemForm = { name: string; key: string; repoUrl: string; defaultBranch: string; docsPath: string; description: string };
export type FormErrors = Partial<Record<keyof SystemForm, string>>;

export function validateSystemForm(form: SystemForm, { editing = false }: { editing?: boolean } = {}): FormErrors {
  const errors: FormErrors = {};
  if (!form.name.trim()) errors.name = "Enter a name.";
  else if (form.name.trim().length > 200) errors.name = "Use at most 200 characters.";
  if (!editing) {
    if (!SYSTEM_KEY.test(form.key.trim())) errors.key = "Use lowercase letters, digits and dashes, starting with a letter or digit (up to 63 characters).";
    if (!GITHUB_REPO.test(form.repoUrl.trim().replace(/\.git$/, ""))) errors.repoUrl = "Use a plain https://github.com/<owner>/<repo> address.";
  }
  const branch = form.defaultBranch.trim();
  if (!BRANCH.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) errors.defaultBranch = "Enter a branch name such as main.";
  const docs = form.docsPath.trim();
  if (!DOCS_PATH.test(docs) || docs.startsWith("/") || docs.split("/").includes("..")) errors.docsPath = "Use a folder inside the repository, such as docs.";
  if (form.description.length > 2000) errors.description = "Use at most 2000 characters.";
  return errors;
}

/** Errors the staff member can act on, from the server's `{ error }` body. */
export function systemsErrorMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const body = (error as { body?: { error?: string } } | null)?.body;
  if (status === 409) return "A system with this key already exists.";
  if (status === 403) return "You do not have permission for this.";
  if (status === 404) return "Not found or no longer available.";
  return body?.error || (error instanceof Error ? error.message : "Something went wrong. Try again.");
}
