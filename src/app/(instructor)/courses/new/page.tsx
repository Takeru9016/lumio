"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UploadDropzone } from "@/lib/uploadthing";
import { toast } from "gooey-toast";

const courseSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters"),
  description: z.string().optional(),
  category: z.string().optional(),
  level: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
  price: z.number().min(0),
  currency: z.string(),
});

type CourseFormData = z.infer<typeof courseSchema>;

const LEVELS = ["BEGINNER", "INTERMEDIATE", "ADVANCED"] as const;
const CATEGORIES = [
  "Technology",
  "Business",
  "Design",
  "Marketing",
  "Personal Development",
  "Other",
];

export default function NewCoursePage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
    trigger,
  } = useForm<CourseFormData>({
    resolver: zodResolver(courseSchema),
    defaultValues: { price: 0, currency: "INR" },
  });

  async function goToStep2() {
    const valid = await trigger(["title"]);
    if (valid) setStep(2);
  }

  async function onSubmit(data: CourseFormData) {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, thumbnailUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      const course = await res.json();
      router.push(`/courses/${course.id}/edit`);
    } catch (e) {
      toast.error({ title: "Failed to create course", description: e instanceof Error ? e.message : undefined });
      setIsSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm text-(--color-text-primary) placeholder:text-(--color-text-disabled) focus:outline-none focus:ring-2 focus:ring-(--color-brand) focus:border-transparent transition-all";

  const labelClass = "block text-sm font-medium text-(--color-text-primary) mb-1.5";

  return (
    <div className="max-w-xl mx-auto px-6 py-10">
      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                step >= s
                  ? "bg-(--color-brand) text-white"
                  : "bg-(--color-surface-3) text-(--color-text-muted)"
              }`}
            >
              {s}
            </div>
            {s < 3 && (
              <div
                className={`h-px w-10 transition-colors ${
                  step > s ? "bg-(--color-brand)" : "bg-(--color-border)"
                }`}
              />
            )}
          </div>
        ))}
        <span className="ml-3 text-sm text-(--color-text-muted)">
          {step === 1 && "Basic info"}
          {step === 2 && "Thumbnail"}
          {step === 3 && "Confirm"}
        </span>
      </div>

      <h1 className="text-[22px] font-semibold font-heading mb-6">
        {step === 1 && "Create a new course"}
        {step === 2 && "Add a thumbnail"}
        {step === 3 && "Review & create"}
      </h1>

      {/* Step 1 */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <label className={labelClass}>
              Course title <span className="text-(--color-danger)">*</span>
            </label>
            <input
              {...register("title")}
              className={`${inputClass} ${errors.title ? "border-(--color-danger) focus:ring-(--color-danger)" : ""}`}
              placeholder="e.g. Complete Next.js Developer Course"
            />
            {errors.title && (
              <p className="mt-1 text-xs text-(--color-danger)">{errors.title.message}</p>
            )}
          </div>

          <div>
            <label className={labelClass}>Description</label>
            <textarea
              {...register("description")}
              rows={3}
              className={inputClass}
              placeholder="What will students learn?"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
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
            <div>
              <label className={labelClass}>Level</label>
              <select {...register("level")} className={inputClass}>
                <option value="">Select level</option>
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l.charAt(0) + l.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Price</label>
              <input
                {...register("price", { valueAsNumber: true })}
                type="number"
                min={0}
                step={1}
                className={inputClass}
                placeholder="0"
              />
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <select {...register("currency")} className={inputClass}>
                <option value="INR">INR ₹</option>
                <option value="USD">USD $</option>
              </select>
            </div>
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="button"
              onClick={goToStep2}
              className="bg-(--color-brand) text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors"
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <div className="space-y-5">
          {thumbnailUrl ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl}
                alt="Thumbnail"
                className="w-full aspect-video object-cover rounded-lg border border-(--color-border)"
              />
              <button
                type="button"
                onClick={() => setThumbnailUrl(null)}
                className="absolute top-2 right-2 bg-white border border-(--color-border) rounded-md px-2 py-1 text-xs text-(--color-text-muted) hover:bg-(--color-surface-2)"
              >
                Remove
              </button>
            </div>
          ) : (
            <UploadDropzone
              endpoint="thumbnailUploader"
              onClientUploadComplete={(res) => {
                if (res[0]) setThumbnailUrl(res[0].ufsUrl);
              }}
              onUploadError={(e) => { toast.error({ title: "Upload failed", description: e.message }); }}
            />
          )}
          <p className="text-xs text-(--color-text-muted)">
            Recommended: 1280×720px, max 4MB. You can change this later.
          </p>
          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="text-(--color-text-muted) rounded-md px-4 py-2 text-sm font-medium hover:bg-(--color-surface-2) transition-colors"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="bg-(--color-brand) text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors"
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <div className="bg-white border border-(--color-border) rounded-lg divide-y divide-(--color-border)">
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbnailUrl}
                alt="Thumbnail"
                className="w-full aspect-video object-cover rounded-t-lg"
              />
            )}
            <div className="p-4 space-y-2">
              <p className="text-sm font-semibold text-(--color-text-primary)">
                {getValues("title")}
              </p>
              {getValues("description") && (
                <p className="text-sm text-(--color-text-muted) line-clamp-2">
                  {getValues("description")}
                </p>
              )}
            </div>
            <div className="px-4 py-3 grid grid-cols-3 gap-2 text-xs text-(--color-text-muted)">
              <span>{getValues("category") || "No category"}</span>
              <span className="text-center">{getValues("level") || "Any level"}</span>
              <span className="text-right">
                {getValues("price") > 0
                  ? `${getValues("currency")} ${getValues("price")}`
                  : "Free"}
              </span>
            </div>
          </div>

          <div className="flex justify-between pt-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="text-(--color-text-muted) rounded-md px-4 py-2 text-sm font-medium hover:bg-(--color-surface-2) transition-colors"
            >
              ← Back
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-(--color-brand) text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-(--color-brand-dark) transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Creating…" : "Create course"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
