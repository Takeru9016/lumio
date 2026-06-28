"use client";

import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Video,
  FileText,
  HelpCircle,
  ClipboardList,
  GripVertical,
  Pencil,
  Clock,
  Plus,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useState } from "react";
import type { LessonType, VideoStatus } from "@/generated/prisma/enums";
import { InlineInput } from "@/components/course/InlineInput";

export interface LessonItem {
  id: string;
  title: string;
  type: LessonType;
  order: number;
  isPublished: boolean;
  videoStatus: VideoStatus;
  videoDuration: number | null;
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
  onEdit,
}: {
  lesson: LessonItem;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `lesson-${lesson.id}` });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors group ${
        isDragging ? "opacity-50" : ""
      } ${
        isSelected
          ? "bg-(--color-brand-light) text-(--color-brand)"
          : "hover:bg-(--color-surface-3) text-(--color-text-secondary)"
      }`}
      onClick={onSelect}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-(--color-text-disabled) hover:text-(--color-text-muted) shrink-0"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical size={13} />
      </button>

      <span className={`shrink-0 ${isSelected ? "text-(--color-brand)" : "text-(--color-text-muted)"}`}>
        {typeIcons[lesson.type]}
      </span>

      <span className="text-xs flex-1 truncate font-medium">{lesson.title}</span>

      {lesson.videoDuration && lesson.type === "VIDEO" && (
        <span className="text-[10px] text-(--color-text-muted) flex items-center gap-0.5 shrink-0">
          <Clock size={10} />
          {formatDuration(lesson.videoDuration)}
        </span>
      )}

      {lesson.isPublished ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-(--color-success-bg) text-(--color-success) shrink-0">
          Live
        </span>
      ) : (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-(--color-surface-3) text-(--color-text-muted) shrink-0">
          Draft
        </span>
      )}

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEdit(); }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-(--color-border) transition-opacity shrink-0"
      >
        <Pencil size={11} />
      </button>
    </div>
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
}: {
  section: SectionItem;
  selectedLessonId: string | null;
  onSelectLesson: (lessonId: string, sectionId: string) => void;
  onAddLesson: () => void;
  onLessonReorder: (newLessons: LessonItem[]) => void;
  showLessonInput: boolean;
  onLessonInputConfirm: (title: string) => void;
  onLessonInputCancel: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: `section-${section.id}` });

  const lessonIds = section.lessons.map((l) => `lesson-${l.id}`);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
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
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-50" : ""}
    >
      {/* Section header */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 group">
        <button
          type="button"
          className="cursor-grab touch-none text-(--color-text-disabled) hover:text-(--color-text-muted)"
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 flex-1 min-w-0"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <span className="text-xs font-semibold text-(--color-text-primary) truncate">
            {section.title}
          </span>
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAddLesson(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-(--color-surface-3) text-(--color-text-muted) transition-opacity"
          title="Add lesson"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Lessons */}
      {!collapsed && (
        <div className="ml-3 pl-2 border-l border-(--color-border) space-y-0.5">
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
                  onEdit={() => onSelectLesson(lesson.id, section.id)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {section.lessons.length === 0 && !showLessonInput && (
            <p className="text-[11px] text-(--color-text-disabled) px-3 py-2">No lessons yet</p>
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
              className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] text-(--color-text-muted) hover:text-(--color-brand) hover:bg-(--color-brand-light) rounded-md transition-colors"
            >
              <Plus size={11} /> Add lesson
            </button>
          )}
        </div>
      )}
    </div>
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
}: LessonListProps) {
  const [inlineFor, setInlineFor] = useState<null | "section" | string>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
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
    const reordered = sections.map((s) =>
      s.id === sectionId ? { ...s, lessons: newLessons } : s
    );
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
              />
            ))}
          </SortableContext>
        </DndContext>

        {sections.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-(--color-text-muted) mb-3">No sections yet</p>
            {inlineFor === "section" ? (
              <InlineInput
                placeholder="Section title"
                onConfirm={(title) => { onAddSection(title); setInlineFor(null); }}
                onCancel={() => setInlineFor(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setInlineFor("section")}
                className="text-xs bg-(--color-brand) text-white rounded-md px-3 py-1.5 font-medium hover:bg-(--color-brand-dark) transition-colors"
              >
                Add first section
              </button>
            )}
          </div>
        )}
      </div>

      {sections.length > 0 && (
        <div className="border-t border-(--color-border) p-3">
          {inlineFor === "section" ? (
            <InlineInput
              placeholder="Section title"
              onConfirm={(title) => { onAddSection(title); setInlineFor(null); }}
              onCancel={() => setInlineFor(null)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setInlineFor("section")}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-(--color-text-muted) border border-dashed border-(--color-border) rounded-md hover:border-(--color-brand) hover:text-(--color-brand) transition-colors"
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
