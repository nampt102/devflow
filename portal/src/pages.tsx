import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, api, describeError, type RequestItem } from "./api";
import { checkFiles, MAX_FILES } from "./files";
import { formatDate, formatSize } from "./format";
import { pathFor, type Route } from "./route";
import { STATUS_CLOSED, STATUS_DONE, vi } from "./vi";

export type Navigate = (route: Route, state?: { notice?: string }) => void;

function Link({ to, navigate, className, children }: { to: Route; navigate: Navigate; className?: string; children: React.ReactNode }) {
  return (
    <a
      className={className}
      href={pathFor(to)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function StatusChip({ label }: { label: string }) {
  const tone = label === STATUS_DONE ? "done" : label === STATUS_CLOSED ? "closed" : "active";
  return <span className={`chip chip-${tone}`}>{label}</span>;
}

function Alert({ kind, children }: { kind: "error" | "success"; children: React.ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const run = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (data) => alive && setState({ data, loading: false }),
      (err) => alive && setState({ error: describeError(err), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => run(), [run]);
  return { ...state, reload: run };
}

/** File picker that keeps the chosen files in the parent and checks them before upload. */
function FilePicker({ files, onChange, alreadyAttached = 0 }: { files: File[]; onChange: (files: File[]) => void; alreadyAttached?: number }) {
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const add = (picked: FileList | null) => {
    if (!picked) return;
    const next = [...files, ...Array.from(picked)];
    const message = checkFiles(next, alreadyAttached);
    setProblem(message);
    if (!message) onChange(next);
    if (input.current) input.current.value = "";
  };
  return (
    <div className="files">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
        onChange={(event) => add(event.target.files)}
      />
      <button type="button" className="btn btn-secondary" onClick={() => input.current?.click()} disabled={files.length + alreadyAttached >= MAX_FILES}>
        {vi.form.chooseFiles}
      </button>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <span className="file-name">{file.name}</span>
              <span className="muted">{formatSize(file.size)}</span>
              <button type="button" className="link-button" onClick={() => onChange(files.filter((_, i) => i !== index))}>
                {vi.form.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HomePage({ navigate }: { navigate: Navigate }) {
  const { data, error, loading, reload } = useLoad(() => api.list(), []);
  const items = data?.items ?? [];
  return (
    <section>
      <div className="page-head">
        <h1>{vi.list.title}</h1>
        <Link to={{ name: "new" }} navigate={navigate} className="btn btn-primary">
          {vi.list.newRequest}
        </Link>
      </div>
      {error && (
        <Alert kind="error">
          {error} <button className="link-button" onClick={reload}>{vi.retry}</button>
        </Alert>
      )}
      {loading && !data && <p className="muted">{vi.loading}</p>}
      {!loading && !error && items.length === 0 && (
        <div className="empty">
          <p><strong>{vi.list.empty}</strong></p>
          <p className="muted">{vi.list.emptyHint}</p>
        </div>
      )}
      <ul className="cards">
        {items.map((item) => (
          <li key={item.number}>
            <Link to={{ name: "request", number: item.number }} navigate={navigate} className="card">
              <div className="card-top">
                <span className="code">{item.code}</span>
                <StatusChip label={item.statusLabel} />
              </div>
              <div className="card-title">{item.title}</div>
              <div className="muted">{vi.list.sentOn} {formatDate(item.createdAt)}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NewRequestPage({ navigate }: { navigate: Navigate }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [impact, setImpact] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !description.trim()) {
      setError(vi.errors.requiredField);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.submit({ title: title.trim(), description: description.trim(), businessImpact: impact }, files);
      navigate({ name: "request", number: created.number }, { notice: vi.form.submitted });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="page-head">
        <h1>{vi.form.title}</h1>
      </div>
      <form className="form" onSubmit={submit} noValidate>
        {error && <Alert kind="error">{error}</Alert>}
        <label className="field">
          <span className="label">{vi.form.subject}</span>
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={vi.form.subjectHint} required />
        </label>
        <label className="field">
          <span className="label">{vi.form.description}</span>
          <textarea value={description} maxLength={8000} rows={7} onChange={(e) => setDescription(e.target.value)} placeholder={vi.form.descriptionHint} required />
          <span className="hint">{description.length}/8000 {vi.form.characters}</span>
        </label>
        <label className="field">
          <span className="label">{vi.form.impact}</span>
          <textarea value={impact} maxLength={4000} rows={3} onChange={(e) => setImpact(e.target.value)} placeholder={vi.form.impactHint} />
        </label>
        <div className="field">
          <span className="label">{vi.form.files}</span>
          <FilePicker files={files} onChange={setFiles} />
          <span className="hint">{vi.form.filesHint}</span>
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? vi.form.submitting : vi.form.submit}</button>
          <Link to={{ name: "home" }} navigate={navigate} className="btn btn-ghost">{vi.back}</Link>
        </div>
      </form>
    </section>
  );
}

export function DetailPage({ number, navigate, notice }: { number: number; navigate: Navigate; notice?: string }) {
  const { data, error, loading, reload } = useLoad(() => api.get(number), [number]);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const attached = data?.attachments?.length ?? 0;

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (busy || files.length === 0) return;
    setBusy(true);
    setUploadError(null);
    try {
      await api.addFiles(number, files);
      setFiles([]);
      setUploaded(true);
      reload();
    } catch (err) {
      setUploadError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) {
    return (
      <section>
        <Alert kind="error">{error}</Alert>
        <Link to={{ name: "home" }} navigate={navigate} className="btn btn-ghost">{vi.back}</Link>
      </section>
    );
  }
  if (!data) return <p className="muted">{loading ? vi.loading : ""}</p>;
  const item: RequestItem = data;
  return (
    <section>
      <Link to={{ name: "home" }} navigate={navigate} className="back-link">&larr; {vi.list.title}</Link>
      {notice && <Alert kind="success">{notice}</Alert>}
      <div className="page-head">
        <div>
          <div className="code">{item.code}</div>
          <h1>{item.title}</h1>
        </div>
        <StatusChip label={item.statusLabel} />
      </div>
      <dl className="meta">
        <div><dt>{vi.detail.sentOn}</dt><dd>{formatDate(item.createdAt)}</dd></div>
        <div><dt>{vi.detail.updatedOn}</dt><dd>{formatDate(item.updatedAt)}</dd></div>
      </dl>
      <h2>{vi.detail.description}</h2>
      <p className="prose">{item.description}</p>
      {item.businessImpact && (
        <>
          <h2>{vi.detail.impact}</h2>
          <p className="prose">{item.businessImpact}</p>
        </>
      )}
      <h2>{vi.detail.attachments}</h2>
      {attached === 0 ? (
        <p className="muted">{vi.detail.noAttachments}</p>
      ) : (
        <ul className="file-list file-list-plain">
          {item.attachments!.map((file) => (
            <li key={file.id}>
              <a href={api.attachmentUrl(number, file.id)} download={file.filename}>{file.filename}</a>
              <span className="muted">{formatSize(file.byteSize)}</span>
            </li>
          ))}
        </ul>
      )}
      {attached < MAX_FILES && (
        <form className="form form-inline" onSubmit={upload}>
          <h3>{vi.detail.addFiles}</h3>
          {uploadError && <Alert kind="error">{uploadError}</Alert>}
          {uploaded && !uploadError && <Alert kind="success">{vi.detail.added}</Alert>}
          <FilePicker files={files} onChange={setFiles} alreadyAttached={attached} />
          {files.length > 0 && (
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? vi.detail.uploading : vi.detail.upload}</button>
          )}
        </form>
      )}
    </section>
  );
}

export function NotFoundPage({ navigate }: { navigate: Navigate }) {
  return (
    <section>
      <h1>{vi.notFound.title}</h1>
      <Link to={{ name: "home" }} navigate={navigate} className="btn btn-primary">{vi.notFound.home}</Link>
    </section>
  );
}

export { ApiError };
