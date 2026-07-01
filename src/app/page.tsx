import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-[#FAFAFA]">
      <div className="flex flex-col items-center gap-3">
        <span className="text-4xl font-bold tracking-tight text-[#0F0F10]">Lumio</span>
        <p className="text-base text-text-muted">Learn with intelligence.</p>
      </div>

      <div className="flex gap-3">
        <Link
          href="/sign-in"
          className="rounded-lg border border-[#E5E5E7] bg-white px-5 py-2.5 text-sm font-medium text-[#0F0F10] hover:bg-[#F5F5F6] transition-colors"
        >
          Sign in
        </Link>
        <Link
          href="/sign-up"
          className="rounded-lg bg-[#4F6EF7] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#3451D1] transition-colors"
        >
          Get started free
        </Link>
      </div>
    </div>
  );
}
