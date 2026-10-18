/** One switch for every DevFlow background worker (Triage, embeddings, status emails): DEVFLOW_WORKERS_ENABLED=false. */
export const devflowWorkersDisabled = (env: NodeJS.ProcessEnv): boolean => /^(0|false|no|off)$/i.test((env.DEVFLOW_WORKERS_ENABLED ?? "").trim());
