"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "gooey-toast";
import { UploadButton } from "@/lib/uploadthing";
import { Loader2 } from "lucide-react";

const schema = z.object({
  title: z.string().min(3, "At least 3 characters").max(100, "Max 100 characters"),
  description: z
    .string()
    .refine((v) => !v || v.length >= 100, "At least 100 characters if provided")
    .refine((v) => !v || v.length <= 5000, "Max 5000 characters")
    .optional(),
  thumbnailUrl: z.string().optional(),
  category: z.string().optional(),
  level: z.string().optional(),
  price: z.number().min(0, "Must be ≥ 0"),
  currency: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

const CATEGORIES = [
  "Technology",
  "Business",
  "Design",
  "Marketing",
  "Personal Development",
  "Other",
];

const LEVELS = [
  { value: "BEGINNER", label: "Beginner" },
  { value: "INTERMEDIATE", label: "Intermediate" },
  { value: "ADVANCED", label: "Advanced" },
];

interface CourseSettingsFormProps {
  courseId: string;
  initialData: {
    title: string;
    description: string | null;
    thumbnailUrl: string | null;
    category: string | null;
    level: string | null;
    price: number;
    currency: string;
  };
}

export function CourseSettingsForm({ courseId, initialData }: CourseSettingsFormProps) {
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(
    initialData.thumbnailUrl ?? null,
  );
  const [isSaving, setIsSaving] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: initialData.title,
      description: initialData.description ?? "",
      thumbnailUrl: initialData.thumbnailUrl ?? "",
      category: initialData.category ?? "",
      level: initialData.level ?? "",
      price: initialData.price,
      currency: initialData.currency,
    },
  });

  const { register, handleSubmit, watch, formState: { errors } } = form;

  const descriptionValue = watch("description") ?? "";

  async function onSubmit(data: FormValues) {
    setIsSaving(true);
    try {
      const payload: Record<string, unknown> = {
        title: data.title,
        price: data.price,
        currency: data.currency,
        description: data.description || undefined,
        thumbnailUrl: data.thumbnailUrl || undefined,
        category: data.category || undefined,
        level: data.level || undefined,
      };

      const res = await fetch(`/api/courses/${courseId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(await res.text());
      toast.success({ title: "Settings saved" });
    } catch {
      toast.error({ title: "Failed to save settings" });
    } finally {
      setIsSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-disabled) focus:outline-none focus:ring-2 focus:ring-(--color-brand) focus:border-transparent transition-all";
  const labelClass = "block text-sm font-medium text-(--color-text-primary) mb-1.5";
  const errorClass = "mt-1 text-xs text-(--color-danger)";

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      {/* Title */}
      <div>
        <label className={labelClass}>
          Course title <span className="text-(--color-danger)">*</span>
        </label>
        <input
          {...register("title")}
          className={`${inputClass} ${errors.title ? "border-(--color-danger)" : ""}`}
          placeholder="e.g. Complete Next.js Developer Course"
        />
        {errors.title && <p className={errorClass}>{errors.title.message}</p>}
      </div>

      {/* Description */}
      <div>
        <label className={labelClass}>Description</label>
        <textarea
          {...register("description")}
          rows={6}
          className={`${inputClass} resize-none ${errors.description ? "border-(--color-danger)" : ""}`}
          placeholder="Describe what students will learn. Min 100 characters."
        />
        <div className="mt-1 flex items-center justify-between">
          {errors.description ? (
            <p className={errorClass}>{errors.description.message}</p>
          ) : (
            <p
              className={`text-xs ${
                descriptionValue.length > 0 && descriptionValue.length < 100
                  ? "text-(--color-danger)"
                  : "text-(--color-text-muted)"
              }`}
            >
              {descriptionValue.length > 0 && descriptionValue.length < 100
                ? `${100 - descriptionValue.length} more characters needed`
                : ""}
            </p>
          )}
          <p className="text-xs text-(--color-text-muted) ml-auto">
            {descriptionValue.length} / 5000
          </p>
        </div>
      </div>

      {/* Thumbnail */}
      <div>
        <label className={labelClass}>Thumbnail</label>
        {thumbnailPreview ? (
          <div className="relative aspect-video w-full max-w-sm rounded-lg overflow-hidden border border-[var(--color-border)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailPreview}
              alt="Thumbnail"
              className="w-full h-full object-cover"
            />
            <button
              type="button"
              onClick={() => {
                setThumbnailPreview(null);
                form.setValue("thumbnailUrl", "");
              }}
              className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-md"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="border-2 border-dashed border-[var(--color-border)] rounded-lg p-6 text-center">
            <UploadButton
              endpoint="thumbnailUploader"
              onClientUploadComplete={(res) => {
                if (res[0]) {
                  const url = res[0].url;
                  form.setValue("thumbnailUrl", url);
                  setThumbnailPreview(url);
                }
              }}
              onUploadError={(e) => {
                toast.error({ title: "Upload failed", description: e.message });
              }}
              appearance={{
                button: "bg-[var(--color-brand)] text-white rounded-md px-4 py-2 text-sm font-medium",
                allowedContent: "text-[var(--color-text-muted)] text-xs mt-1",
              }}
            />
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              Recommended: 1280×720px, max 4MB
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Category */}
        <div>
          <label className={labelClass}>Category</label>
          <select {...register("category")} className={inputClass}>
            <option value="">Select category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* Level */}
        <div>
          <label className={labelClass}>Level</label>
          <select {...register("level")} className={inputClass}>
            <option value="">Select level</option>
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Price */}
        <div>
          <label className={labelClass}>Price</label>
          <input
            {...register("price", { valueAsNumber: true })}
            type="number"
            min={0}
            step={1}
            className={`${inputClass} ${errors.price ? "border-(--color-danger)" : ""}`}
            placeholder="0"
          />
          {errors.price && <p className={errorClass}>{errors.price.message}</p>}
        </div>

        {/* Currency */}
        <div>
          <label className={labelClass}>Currency</label>
          <select {...register("currency")} className={inputClass}>
            <option value="INR">INR ₹</option>
            <option value="USD">USD $</option>
          </select>
        </div>
      </div>

      <div className="pt-2">
        <button
          type="submit"
          disabled={isSaving}
          className="flex items-center gap-2 bg-(--color-brand) text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving && <Loader2 size={14} className="animate-spin" />}
          {isSaving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
