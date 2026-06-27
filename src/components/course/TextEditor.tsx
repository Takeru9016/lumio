"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

interface TextEditorProps {
  content?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
}

export function TextEditor({
  content = "",
  onChange,
  placeholder = "Start writing lesson content…",
}: TextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
    ],
    content,
    onUpdate({ editor }) {
      onChange?.(editor.getHTML());
    },
    immediatelyRender: false,
  });

  if (!editor) {
    return (
      <div className="w-full min-h-[300px] rounded-lg border border-(--color-border) bg-(--color-surface-2) animate-pulse" />
    );
  }

  return (
    <div className="rounded-lg border border-(--color-border) overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-(--color-border) bg-(--color-surface-2)">
        {[
          { label: "B", action: () => editor.chain().focus().toggleBold().run(), active: editor.isActive("bold") },
          { label: "I", action: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive("italic") },
          { label: "S", action: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive("strike") },
        ].map(({ label, action, active }) => (
          <button
            key={label}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); action(); }}
            className={`w-7 h-7 rounded text-sm font-medium transition-colors ${
              active
                ? "bg-(--color-brand) text-white"
                : "text-(--color-text-muted) hover:bg-(--color-surface-3)"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="w-px h-4 bg-(--color-border) mx-1" />
        {[
          { label: "H2", action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(), active: editor.isActive("heading", { level: 2 }) },
          { label: "H3", action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(), active: editor.isActive("heading", { level: 3 }) },
        ].map(({ label, action, active }) => (
          <button
            key={label}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); action(); }}
            className={`px-2 h-7 rounded text-xs font-medium transition-colors ${
              active
                ? "bg-(--color-brand) text-white"
                : "text-(--color-text-muted) hover:bg-(--color-surface-3)"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="w-px h-4 bg-(--color-border) mx-1" />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
          className={`px-2 h-7 rounded text-xs font-medium transition-colors ${
            editor.isActive("bulletList")
              ? "bg-(--color-brand) text-white"
              : "text-(--color-text-muted) hover:bg-(--color-surface-3)"
          }`}
        >
          • List
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCodeBlock().run(); }}
          className={`px-2 h-7 rounded text-xs font-mono transition-colors ${
            editor.isActive("codeBlock")
              ? "bg-(--color-brand) text-white"
              : "text-(--color-text-muted) hover:bg-(--color-surface-3)"
          }`}
        >
          {"</>"}
        </button>
      </div>

      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none min-h-[300px] px-4 py-3 focus-within:outline-none text-(--color-text-primary) [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-(--color-text-disabled) [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none"
      />
    </div>
  );
}
