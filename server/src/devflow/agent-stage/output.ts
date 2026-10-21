// Reading a stage agent's final message. Error messages carry paths and rule names only, never the agent's text,
// because they are fed back to the agent on retry and logged.

export class AgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

/** The JSON object in the agent's final message: the whole text, a fenced block, or the last top-level object. */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const value = JSON.parse(c);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  throw new AgentOutputError("output is not a JSON object");
}

/** A path the agent cites that does not stay inside the repository. */
export const unsafePath = (p: string) => p.startsWith("/") || p.startsWith("~") || p.includes("\\") || p.split("/").includes("..") || /[\u0000-\u001f]/.test(p);

/** Schema problems as "path: code" pairs, for the retry message. */
export const describeIssues = (issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>) =>
  issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.code}`)
    .join("; ");
