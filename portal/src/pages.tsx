import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ApiError, api, describeError, type RequestItem } from "./api";
import { checkFiles, MAX_FILES } from "./files";
import { formatDate, formatSize } from "./format";
import { ArrowLeftIcon, DownloadIcon, FileIcon, InboxIcon, PlusIcon, UploadIcon, XIcon } from "./icons";
import { Alert, Link, ListSkeleton, Spinner, StatusChip, type Navigate } from "./ui";
import { vi } from "./vi";

export type { Navigate };
export { StatusChip };

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

/** Drop zone and picker that keeps the chosen files in the parent and checks them before upload. */
function FilePicker({ files, onChange, alreadyAttached = 0 }: { files: File[]; onChange: (files: File[]) => void; alreadyAttached?: number }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const full = files.length + alreadyAttached >= MAX_FILES;
  const add = (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const next = [...files, ...Array.from(picked)];
    const message = checkFiles(next, alreadyAttached);
    setProblem(message);
    if (!message) onChange(next);
    if (input.current) input.current.value = "";
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (!full) add(event.dataTransfer.files);
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
      <button
        type="button"
        className="dropzone"
        data-over={over}
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        disabled={full}
      >
        <UploadIcon />
        <strong>{full ? vi.form.dropFull : vi.form.dropPrompt}</strong>
        <span>{vi.form.filesHint}</span>
      </button>
      {problem && <p className="field-error" role="alert">{problem}</p>}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <FileIcon />
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatSize(file.size)}</span>
              <button type="button" className="btn btn-ghost btn-icon" aria-label={`${vi.form.removeFile} ${file.name}`} onClick={() => onChange(files.filter((_, i) => i !== index))}>
                <XIcon />
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
        <div>
          <h1>{vi.list.title}</h1>
          <p className="page-sub">{vi.list.subtitle}</p>
        </div>
        <Link to={{ name: "new" }} navigate={navigate} className="btn btn-primary">
          <PlusIcon /> {vi.list.newRequest}
        </Link>
      </div>
      {error && (
        <Alert kind="error">
          {error} <button className="link-button" onClick={reload}>{vi.retry}</button>
        </Alert>
      )}
      {loading && !data && (
        <div role="status" aria-label={vi.loading}>
          <ListSkeleton />
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="empty">
          <InboxIcon />
          <strong>{vi.list.empty}</strong>
          <span>{vi.list.emptyHint}</span>
          <Link to={{ name: "new" }} navigate={navigate} className="btn btn-primary">
            <PlusIcon /> {vi.list.newRequest}
          </Link>
        </div>
      )}
      <ul className="cards">
        {items.map((item) => (
          <li key={item.number}>
            <Link to={{ name: "request", number: item.number }} navigate={navigate} className="card row-card">
              <div className="row-top">
                <span className="code">{item.code}</span>
                <StatusChip label={item.statusLabel} />
              </div>
              <div className="row-title">{item.title}</div>
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
  const [touched, setTouched] = useState({ title: false, description: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleMissing = touched.title && !title.trim();
  const descriptionMissing = touched.description && !description.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim() || !description.trim()) {
      setTouched({ title: true, description: true });
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
      <Link to={{ name: "home" }} navigate={navigate} className="back-link">
        <ArrowLeftIcon /> {vi.list.title}
      </Link>
      <div className="page-head">
        <h1>{vi.form.title}</h1>
      </div>
      <form className="card form form-card" onSubmit={submit} noValidate>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field">
          <label className="label" htmlFor="req-title">
            {vi.form.subject}
            <span className="req">({vi.form.required})</span>
          </label>
          <input
            id="req-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, title: true }))}
            placeholder={vi.form.subjectHint}
            aria-invalid={titleMissing}
            aria-describedby={titleMissing ? "req-title-error" : undefined}
            required
          />
          {titleMissing && <p id="req-title-error" className="field-error">{vi.form.fieldRequired}</p>}
        </div>
        <div className="field">
          <label className="label" htmlFor="req-description">
            {vi.form.description}
            <span className="req">({vi.form.required})</span>
          </label>
          <textarea
            id="req-description"
            value={description}
            maxLength={8000}
            rows={7}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, description: true }))}
            placeholder={vi.form.descriptionHint}
            aria-invalid={descriptionMissing}
            aria-describedby={descriptionMissing ? "req-description-error" : "req-description-hint"}
            required
          />
          {descriptionMissing ? (
            <p id="req-description-error" className="field-error">{vi.form.fieldRequired}</p>
          ) : (
            <span id="req-description-hint" className="hint">{description.length}/8000 {vi.form.characters}</span>
          )}
        </div>
        <div className="field">
          <label className="label" htmlFor="req-impact">
            {vi.form.impact}
          </label>
          <textarea id="req-impact" value={impact} maxLength={4000} rows={3} onChange={(e) => setImpact(e.target.value)} placeholder={vi.form.impactHint} />
        </div>
        <div className="field">
          <span className="label" id="req-files-label">{vi.form.files}</span>
          <FilePicker files={files} onChange={setFiles} />
        </div>
        <div className="form-footer">
          <Link to={{ name: "home" }} navigate={navigate} className="btn btn-ghost">{vi.back}</Link>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {busy ? vi.form.submitting : vi.form.submit}
          </button>
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
        <Link to={{ name: "home" }} navigate={navigate} className="btn btn-secondary">{vi.back}</Link>
      </section>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-label={vi.loading}>
        <ListSkeleton />
      </div>
    );
  }
  const item: RequestItem = data;
  return (
    <section>
      <Link to={{ name: "home" }} navigate={navigate} className="back-link">
        <ArrowLeftIcon /> {vi.list.title}
      </Link>
      {notice && <Alert kind="success">{notice}</Alert>}
      <div className="page-head">
        <div>
          <div className="code">{item.code}</div>
          <h1>{item.title}</h1>
        </div>
        <StatusChip label={item.statusLabel} />
      </div>

      <div className="card">
        <dl className="meta">
          <div><dt>{vi.detail.sentOn}</dt><dd>{formatDate(item.createdAt)}</dd></div>
          <div><dt>{vi.detail.updatedOn}</dt><dd>{formatDate(item.updatedAt)}</dd></div>
        </dl>
      </div>

      <h2>{vi.detail.description}</h2>
      <div className="card"><p className="prose">{item.description}</p></div>
      {item.businessImpact && (
        <>
          <h2>{vi.detail.impact}</h2>
          <div className="card"><p className="prose">{item.businessImpact}</p></div>
        </>
      )}

      <h2>{vi.detail.attachments}</h2>
      {attached === 0 ? (
        <p className="muted">{vi.detail.noAttachments}</p>
      ) : (
        <ul className="file-list">
          {item.attachments!.map((file) => (
            <li key={file.id}>
              <FileIcon />
              <span className="file-name">
                <a href={api.attachmentUrl(number, file.id)} download={file.filename}>{file.filename}</a>
              </span>
              <span className="file-size">{formatSize(file.byteSize)}</span>
              <DownloadIcon />
            </li>
          ))}
        </ul>
      )}
      {attached < MAX_FILES && (
        <form className="card form add-files" onSubmit={upload}>
          <h3>{vi.detail.addFiles}</h3>
          {uploadError && <Alert kind="error">{uploadError}</Alert>}
          {uploaded && !uploadError && <Alert kind="success">{vi.detail.added}</Alert>}
          <FilePicker files={files} onChange={setFiles} alreadyAttached={attached} />
          {files.length > 0 && (
            <div className="form-footer">
              <span />
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy && <Spinner />} {busy ? vi.detail.uploading : vi.detail.upload}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}

export function NotFoundPage({ navigate }: { navigate: Navigate }) {
  return (
    <section className="empty">
      <strong>{vi.notFound.title}</strong>
      <Link to={{ name: "home" }} navigate={navigate} className="btn btn-primary">{vi.notFound.home}</Link>
    </section>
  );
}

export { ApiError };
