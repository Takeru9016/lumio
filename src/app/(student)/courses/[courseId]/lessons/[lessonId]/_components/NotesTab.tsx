"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

interface NotesTabProps {
  lessonId: string;
}

export function NotesTab({ lessonId }: NotesTabProps) {
  const storageKey = `lumio:notes:${lessonId}`;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: "Write notes for this lesson…" }),
    ],
    content: "",
    onUpdate({ editor: e }) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        localStorage.setItem(storageKey, e.getHTML());
      }, 600);
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (!editor) return;
    const saved = localStorage.getItem(storageKey);
    if (saved) editor.commands.setContent(saved, { emitUpdate: false });
  }, [editor, storageKey]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  if (!editor) {
    return (
      <div className="min-h-[200px] rounded-lg border border-border bg-surface-2 animate-pulse" />
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-surface-2">
        {[
          {
            label: "B",
            action: () => editor.chain().focus().toggleBold().run(),
            active: editor.isActive("bold"),
          },
          {
            label: "I",
            action: () => editor.chain().focus().toggleItalic().run(),
            active: editor.isActive("italic"),
          },
        ].map(({ label, action, active }) => (
          <button
            key={label}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              action();
            }}
            className={`w-7 h-7 rounded text-sm font-medium transition-colors ${
              active
                ? "bg-brand text-white"
                : "text-text-muted hover:bg-surface-3"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="w-px h-4 bg-border mx-1" />
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault();
            editor.chain().focus().toggleBulletList().run();
          }}
          className={`px-2 h-7 rounded text-xs font-medium transition-colors ${
            editor.isActive("bulletList")
              ? "bg-brand text-white"
              : "text-text-muted hover:bg-surface-3"
          }`}
        >
          • List
        </button>
        <span className="ml-auto text-[10px] text-text-disabled">
          Auto-saved
        </span>
      </div>
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none min-h-[200px] px-4 py-3 focus-within:outline-none text-text-primary [&_.tiptap]:outline-none [&_.tiptap_p.is-editor-empty:first-child::before]:text-text-disabled [&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child::before]:float-left [&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none"
      />
    </div>
  );
}
