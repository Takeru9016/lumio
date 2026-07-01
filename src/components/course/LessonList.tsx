"use client";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  GripVertical,
  HelpCircle,
  Pencil,
  Plus,
  Trash2,
  Video,
} from "lucide-react";
import { useState } from "react";

import { InlineInput } from "@/components/course/InlineInput";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

import type { LessonType, VideoStatus } from "@/generated/prisma/enums";

export interface LessonItem {
  id: string;
  title: string;
  type: LessonType;
  order: number;
  isPublished: boolean;
  isArchived: boolean;
  videoStatus: VideoStatus;
  videoDuration: number | null;
  muxPlaybackId?: string | null;
  textContent?: string | null;
  hasQuiz?: boolean;
  hasAssignment?: boolean;
}

export interface SectionItem {
  id: string;
  title: string;
  order: number;
  lessons: LessonItem[];
}

interface LessonListProps {
  courseId: string;
  sections: SectionItem[];
  selectedLessonId: string | null;
  onSelectLesson: (lessonId: string, sectionId: string) => void;
  onAddSection: (title: string) => void;
  onAddLesson: (sectionId: string, title: string) => void;
  onReorder: (sections: SectionItem[]) => void;
  onRenameSection: (sectionId: string, title: string) => void;
  onRenameLesson: (lessonId: string, title: string) => void;
  onDeleteSection: (sectionId: string) => void;
  onDeleteLesson: (lessonId: string, sectionId: string) => void;
  onArchiveLesson: (lessonId: string) => void;
  onUnarchiveLesson: (lessonId: string) => void;
}

const typeIcons: Record<LessonType, React.ReactNode> = {
  VIDEO: <Video size={13} />,
  TEXT: <FileText size={13} />,
  QUIZ: <HelpCircle size={13} />,
  ASSIGNMENT: <ClipboardList size={13} />,
};

function formatDuration(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── Sortable lesson row ──────────────────────────────────────────────────────

function SortableLesson({
  lesson,
  isSelected,
  onSelect,
  onRename,
  onDelete,
  onArchive,
  onUnarchive,
}: {
  lesson: LessonItem;
  isSelected: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `lesson-${lesson.id}`,
  });

  if (isRenaming) {
    return (
      <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
        <InlineInput
          placeholder="Lesson title"
          defaultValue={lesson.title}
          confirmLabel="Save"
          onConfirm={(title) => {
            onRename(title);
            setIsRenaming(false);
          }}
          onCancel={() => setIsRenaming(false)}
        />
      </div>
    );
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors group ${
          isDragging ? "opacity-50" : ""
        } ${
          lesson.isArchived
            ? "opacity-50 hover:bg-surface-3 text-text-secondary"
            : isSelected
              ? "bg-brand-light text-brand"
              : "hover:bg-surface-3 text-text-secondary"
        }`}
        onClick={onSelect}
      >
        <button
          type="button"
          className="cursor-grab touch-none text-text-disabled hover:text-text-muted shrink-0"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={13} />
        </button>

        <span
          className={`shrink-0 ${
            lesson.isArchived ? "text-text-disabled" : isSelected ? "text-brand" : "text-text-muted"
          }`}
        >
          {typeIcons[lesson.type]}
        </span>

        <span className="text-xs flex-1 truncate font-medium">{lesson.title}</span>

        {lesson.isArchived ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 shrink-0">
            Archived
          </span>
        ) : (
          <>
            {lesson.videoDuration && lesson.type === "VIDEO" && (
              <span className="text-[10px] text-text-muted flex items-center gap-0.5 shrink-0">
                <Clock size={10} />
                {formatDuration(lesson.videoDuration)}
              </span>
            )}
            {lesson.isPublished ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-success-bg text-success shrink-0">
                Live
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-3 text-text-muted shrink-0">
                Draft
              </span>
            )}
          </>
        )}

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsRenaming(true);
            }}
            className="p-1 rounded hover:bg-border transition-colors"
            title="Rename"
          >
            <Pencil size={11} />
          </button>
          {lesson.isArchived ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onUnarchive();
              }}
              className="p-1 rounded hover:bg-border transition-colors text-amber-600"
              title="Unarchive"
            >
              <ArchiveRestore size={11} />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onArchive();
              }}
              className="p-1 rounded hover:bg-border transition-colors text-text-muted"
              title="Archive"
            >
              <Archive size={11} />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowDeleteConfirm(true);
            }}
            className="p-1 rounded hover:bg-border transition-colors text-danger"
            title="Delete"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Delete &ldquo;{lesson.title}&rdquo;?</DialogTitle>
          <p className="text-sm text-text-muted -mt-2">
            This cannot be undone. Any video, quiz, or assignment content will be permanently
            removed.
          </p>
          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-surface-3 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onDelete();
                setShowDeleteConfirm(false);
              }}
              className="px-3 py-1.5 text-sm font-medium text-white bg-danger rounded-md hover:opacity-90 transition-opacity"
            >
              Delete
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Sortable section ─────────────────────────────────────────────────────────

function SortableSection({
  section,
  selectedLessonId,
  onSelectLesson,
  onAddLesson,
  onLessonReorder,
  showLessonInput,
  onLessonInputConfirm,
  onLessonInputCancel,
  onRename,
  onDelete,
  onRenameLesson,
  onDeleteLesson,
  onArchiveLesson,
  onUnarchiveLesson,
}: {
  section: SectionItem;
  selectedLessonId: string | null;
  onSelectLesson: (lessonId: string, sectionId: string) => void;
  onAddLesson: () => void;
  onLessonReorder: (newLessons: LessonItem[]) => void;
  showLessonInput: boolean;
  onLessonInputConfirm: (title: string) => void;
  onLessonInputCancel: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onRenameLesson: (lessonId: string, title: string) => void;
  onDeleteLesson: (lessonId: string, sectionId: string) => void;
  onArchiveLesson: (lessonId: string) => void;
  onUnarchiveLesson: (lessonId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `section-${section.id}`,
  });

  const lessonIds = section.lessons.map((l) => `lesson-${l.id}`);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleLessonDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = section.lessons.findIndex((l) => `lesson-${l.id}` === active.id);
    const newIdx = section.lessons.findIndex((l) => `lesson-${l.id}` === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    onLessonReorder(arrayMove(section.lessons, oldIdx, newIdx));
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        className={isDragging ? "opacity-50" : ""}
      >
        {/* Section header */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 group">
          <button
            type="button"
            className="cursor-grab touch-none text-text-disabled hover:text-text-muted"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>

          {isRenaming ? (
            <div className="flex-1 min-w-0">
              <InlineInput
                placeholder="Section title"
                defaultValue={section.title}
                confirmLabel="Save"
                onConfirm={(title) => {
                  onRename(title);
                  setIsRenaming(false);
                }}
                onCancel={() => setIsRenaming(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="flex items-center gap-1 flex-1 min-w-0"
            >
              {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <span className="text-xs font-semibold text-text-primary truncate">
                {section.title}
              </span>
            </button>
          )}

          {!isRenaming && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsRenaming(true);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-3 text-text-muted transition-opacity"
                title="Rename section"
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowDeleteConfirm(true);
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-3 text-danger transition-opacity"
                title="Delete section"
              >
                <Trash2 size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddLesson();
                }}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-3 text-text-muted transition-opacity"
                title="Add lesson"
              >
                <Plus size={12} />
              </button>
            </>
          )}
        </div>

        {/* Lessons */}
        {!collapsed && (
          <div className="ml-3 pl-2 border-l border-border space-y-0.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleLessonDragEnd}
            >
              <SortableContext items={lessonIds} strategy={verticalListSortingStrategy}>
                {section.lessons.map((lesson) => (
                  <SortableLesson
                    key={lesson.id}
                    lesson={lesson}
                    isSelected={selectedLessonId === lesson.id}
                    onSelect={() => onSelectLesson(lesson.id, section.id)}
                    onRename={(title) => onRenameLesson(lesson.id, title)}
                    onDelete={() => onDeleteLesson(lesson.id, section.id)}
                    onArchive={() => onArchiveLesson(lesson.id)}
                    onUnarchive={() => onUnarchiveLesson(lesson.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>

            {section.lessons.length === 0 && !showLessonInput && (
              <p className="text-[11px] text-text-disabled px-3 py-2">No lessons yet</p>
            )}

            {showLessonInput ? (
              <InlineInput
                placeholder="Lesson title"
                onConfirm={onLessonInputConfirm}
                onCancel={onLessonInputCancel}
              />
            ) : (
              <button
                type="button"
                onClick={onAddLesson}
                className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] text-text-muted hover:text-brand hover:bg-brand-light rounded-md transition-colors"
              >
                <Plus size={11} /> Add lesson
              </button>
            )}
          </div>
        )}
      </div>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Delete &ldquo;{section.title}&rdquo;?</DialogTitle>
          <p className="text-sm text-text-muted -mt-2">
            This will permanently delete this section and all{" "}
            <strong>{section.lessons.length}</strong> lesson
            {section.lessons.length !== 1 ? "s" : ""} inside it. This cannot be undone.
          </p>
          <div className="flex items-center justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text-primary hover:bg-surface-3 rounded-md transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onDelete();
                setShowDeleteConfirm(false);
              }}
              className="px-3 py-1.5 text-sm font-medium text-white bg-danger rounded-md hover:opacity-90 transition-opacity"
            >
              Delete section and {section.lessons.length} lesson
              {section.lessons.length !== 1 ? "s" : ""}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function LessonList({
  courseId,
  sections,
  selectedLessonId,
  onSelectLesson,
  onAddSection,
  onAddLesson,
  onReorder,
  onRenameSection,
  onRenameLesson,
  onDeleteSection,
  onDeleteLesson,
  onArchiveLesson,
  onUnarchiveLesson,
}: LessonListProps) {
  const [inlineFor, setInlineFor] = useState<null | "section" | string>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const sectionIds = sections.map((s) => `section-${s.id}`);

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sections.findIndex((s) => `section-${s.id}` === active.id);
    const newIdx = sections.findIndex((s) => `section-${s.id}` === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(sections, oldIdx, newIdx);
    onReorder(reordered);
    persistReorder(courseId, reordered);
  }

  function handleLessonReorder(sectionId: string, newLessons: LessonItem[]) {
    const reordered = sections.map((s) => (s.id === sectionId ? { ...s, lessons: newLessons } : s));
    onReorder(reordered);
    persistReorder(courseId, reordered);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto py-2 space-y-1">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleSectionDragEnd}
        >
          <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
            {sections.map((section) => (
              <SortableSection
                key={section.id}
                section={section}
                selectedLessonId={selectedLessonId}
                onSelectLesson={onSelectLesson}
                onAddLesson={() => setInlineFor(section.id)}
                onLessonReorder={(newLessons) => handleLessonReorder(section.id, newLessons)}
                showLessonInput={inlineFor === section.id}
                onLessonInputConfirm={(title) => {
                  onAddLesson(section.id, title);
                  setInlineFor(null);
                }}
                onLessonInputCancel={() => setInlineFor(null)}
                onRename={(title) => onRenameSection(section.id, title)}
                onDelete={() => onDeleteSection(section.id)}
                onRenameLesson={onRenameLesson}
                onDeleteLesson={onDeleteLesson}
                onArchiveLesson={onArchiveLesson}
                onUnarchiveLesson={onUnarchiveLesson}
              />
            ))}
          </SortableContext>
        </DndContext>

        {sections.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-text-muted mb-3">No sections yet</p>
            {inlineFor === "section" ? (
              <InlineInput
                placeholder="Section title"
                onConfirm={(title) => {
                  onAddSection(title);
                  setInlineFor(null);
                }}
                onCancel={() => setInlineFor(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setInlineFor("section")}
                className="text-xs bg-brand text-white rounded-md px-3 py-1.5 font-medium hover:bg-brand-dark transition-colors"
              >
                Add first section
              </button>
            )}
          </div>
        )}
      </div>

      {sections.length > 0 && (
        <div className="border-t border-border p-3">
          {inlineFor === "section" ? (
            <InlineInput
              placeholder="Section title"
              onConfirm={(title) => {
                onAddSection(title);
                setInlineFor(null);
              }}
              onCancel={() => setInlineFor(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setInlineFor("section")}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-text-muted border border-dashed border-border rounded-md hover:border-brand hover:text-brand transition-colors"
            >
              <Plus size={13} /> Add section
            </button>
          )}
        </div>
      )}
    </div>
  );
}

async function persistReorder(courseId: string, sections: SectionItem[]) {
  await fetch(`/api/courses/${courseId}/reorder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sections: sections.map((s, i) => ({
        id: s.id,
        order: i,
        lessons: s.lessons.map((l, j) => ({ id: l.id, order: j })),
      })),
    }),
  });
}
