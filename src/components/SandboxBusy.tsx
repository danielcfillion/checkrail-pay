import { BrandMark } from "./BrandMark";

/**
 * Sandbox mode, when no copy of the demo can be made for this visitor right now: every copy is in use (none idle for
 * half an hour), or this address started several in the last few minutes. Nobody else's copy is touched to make room.
 */
export function SandboxBusyPage({ className }: { className: string }) {
  return (
    <html lang="en" className={className}>
      <body>
        <main id="main" className="mx-auto max-w-lg px-4 pt-[18vh]">
          <BrandMark size={28} />
          <h1 className="mt-4 text-2xl font-bold tracking-[-0.02em]">The demo is busy</h1>
          <p className="mt-2 text-[15px] leading-[22px] text-ink-soft">Every visitor gets a private copy of the demo, and all of them are in use right now. Try again in a few minutes.</p>
          <p className="mt-5">
            <a href="" className="btn btn-primary">
              Try again
            </a>
          </p>
        </main>
      </body>
    </html>
  );
}
