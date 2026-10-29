"use client";

import Link from "next/link";

/** What a render error shows in place of the framework's default: the product's own words, and a way back. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-ink-soft">This page could not be shown. Nothing was paid or changed by the error. Try again, or go back to the overview.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => reset()}>
          Try again
        </button>
        <Link href="/" className="btn">
          Overview
        </Link>
        <Link href="/obligations" className="btn">
          Inbox
        </Link>
      </div>
    </div>
  );
}
