"use client";

import { FileText, RotateCcw, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { EmptyState } from "@/components";
import type { ManagedDocumentListItem } from "@/lib/domain/knowledge/management";

interface InstructorKnowledgeClientProps {
  initialDocuments: ManagedDocumentListItem[];
}

const MAX_TEXT_CONTENT_LENGTH = 50_000;

function statusBadge(status: string) {
  const styles: Record<string, string> = {
    READY: "bg-surface-2 text-text-secondary",
    PENDING: "bg-surface-2 text-text-muted",
    PROCESSING: "bg-surface-2 text-text-muted",
    ERROR: "bg-danger/10 text-danger",
  };
  return (
    <span
      className={`text-xs font-medium px-2 py-0.5 rounded-full ${styles[status] ?? "bg-surface-2 text-text-muted"}`}
    >
      {status}
    </span>
  );
}

export function InstructorKnowledgeClient({ initialDocuments }: InstructorKnowledgeClientProps) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [title, setTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [visibility, setVisibility] = useState<"TENANT" | "RESTRICTED">("TENANT");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowActionId, setRowActionId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileImport(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();
    setTextContent(text.slice(0, MAX_TEXT_CONTENT_LENGTH));
    if (!title) setTitle(file.name.replace(/\.(txt|md)$/i, ""));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleCreate() {
    setIsCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/knowledge/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, textContent, visibility }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to create document");
      }
      const data: { document: ManagedDocumentListItem } = await res.json();
      setDocuments((prev) => [data.document, ...prev]);
      setTitle("");
      setTextContent("");
      setVisibility("TENANT");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create document");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRetry(id: string) {
    setRowActionId(id);
    setRowError(null);
    try {
      const res = await fetch(`/api/knowledge/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex" }),
      });
      if (!res.ok) throw new Error();
      const data: { document: ManagedDocumentListItem } = await res.json();
      setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, ...data.document } : d)));
    } catch {
      setRowError("Couldn't retry indexing");
    } finally {
      setRowActionId(null);
    }
  }

  async function handleDelete(id: string) {
    setRowActionId(id);
    setRowError(null);
    try {
      const res = await fetch(`/api/knowledge/documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch {
      setRowError("Couldn't delete document");
    } finally {
      setRowActionId(null);
      setConfirmDeleteId(null);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1
          className="text-xl font-bold text-text-primary"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          Knowledge
        </h1>
        <p className="text-sm text-text-muted">
          Documents you add here become part of your tenant's Knowledge base — usable by AI Tutor
          and Search.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
        className="bg-white border border-border rounded-lg p-4 space-y-3 shadow-sm"
      >
        <div className="space-y-1">
          <label htmlFor="doc-title" className="text-xs font-semibold text-text-muted uppercase">
            Title
          </label>
          <input
            id="doc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            className="w-full border border-border rounded-md px-3 py-2 text-sm"
            placeholder="e.g. Onboarding checklist"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label
              htmlFor="doc-content"
              className="text-xs font-semibold text-text-muted uppercase"
            >
              Text content
            </label>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1 text-xs text-brand hover:underline"
            >
              <Upload size={12} />
              Import .txt/.md
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,text/plain,text/markdown"
              onChange={(e) => handleFileImport(e.target.files)}
              className="hidden"
            />
          </div>
          <textarea
            id="doc-content"
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            maxLength={MAX_TEXT_CONTENT_LENGTH}
            required
            rows={6}
            className="w-full border border-border rounded-md px-3 py-2 text-sm font-mono"
            placeholder="Paste or type the document's content..."
          />
          <p className="text-xs text-text-muted">
            {textContent.length.toLocaleString()} / {MAX_TEXT_CONTENT_LENGTH.toLocaleString()}{" "}
            characters
          </p>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="doc-visibility"
            className="text-xs font-semibold text-text-muted uppercase"
          >
            Visibility
          </label>
          <select
            id="doc-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as "TENANT" | "RESTRICTED")}
            className="border border-border rounded-md px-3 py-2 text-sm"
          >
            <option value="TENANT">Everyone in my organization</option>
            <option value="RESTRICTED">Only me (private draft)</option>
          </select>
        </div>

        {createError && <p className="text-sm text-danger">{createError}</p>}

        <button
          type="submit"
          disabled={isCreating}
          className="bg-brand text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-brand-dark transition-colors disabled:opacity-60"
        >
          {isCreating ? "Creating & indexing…" : "Add document"}
        </button>
      </form>

      {rowError && <p className="text-sm text-danger">{rowError}</p>}

      {documents.length === 0 ? (
        <div className="bg-surface-1 border border-border rounded-lg">
          <EmptyState
            title="No documents yet"
            description="Add your first document above to start building your organization's Knowledge base."
          />
        </div>
      ) : (
        <div className="bg-white border border-border rounded-lg overflow-hidden shadow-sm">
          <div className="grid grid-cols-[2fr_100px_140px_120px_140px] px-4 py-2.5 border-b border-border bg-surface-2">
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Title
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Status
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Visibility
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Created
            </span>
            <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              Actions
            </span>
          </div>

          {documents.map((doc) => (
            <div
              key={doc.id}
              className="grid grid-cols-[2fr_100px_140px_120px_140px] items-center px-4 py-3 border-b border-border last:border-0"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary truncate pr-2">
                <FileText size={14} className="text-text-muted shrink-0" />
                {doc.title}
              </span>
              <span>{statusBadge(doc.status)}</span>
              <span className="text-sm text-text-secondary">
                {doc.visibility === "TENANT" ? "Organization" : "Private"}
              </span>
              <span className="text-xs text-text-muted">
                {new Date(doc.createdAt).toLocaleDateString()}
              </span>
              <span className="flex items-center gap-2">
                {doc.status === "ERROR" && (
                  <button
                    type="button"
                    disabled={rowActionId === doc.id}
                    onClick={() => handleRetry(doc.id)}
                    className="flex items-center gap-1 text-xs text-brand hover:underline disabled:opacity-60"
                  >
                    <RotateCcw size={12} />
                    Retry
                  </button>
                )}
                {confirmDeleteId === doc.id ? (
                  <span className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      disabled={rowActionId === doc.id}
                      onClick={() => handleDelete(doc.id)}
                      className="text-danger font-medium hover:underline disabled:opacity-60"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-text-muted hover:underline"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(doc.id)}
                    className="flex items-center gap-1 text-xs text-danger hover:underline"
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
