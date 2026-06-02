export default function PoolInfoPage() {
    return (
    <main className="w-full px-3 py-3 text-zinc-950 sm:px-4 lg:px-6">
      <div className="mx-auto w-full max-w-5xl flex flex-col gap-3">
        <header className="overflow-hidden rounded-[2rem] border border-zinc-200 bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_34%),linear-gradient(180deg,_rgba(255,255,255,0.95),_rgba(248,250,252,0.94))] p-4 shadow-[0_28px_70px_rgba(15,23,42,0.08)] sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-emerald-600">Divant</p>
          <h1 className="mt-2 max-w-xl text-3xl font-semibold tracking-tight text-zinc-950 sm:mt-3 sm:text-5xl">Divide and Transfer. Start splitting your bill hassle-free now.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600 sm:mt-4 sm:text-lg sm:leading-7">
            No account needed. Create a pool in seconds and ask your friends to join.
          </p>
        </header>

        <div className="hidden gap-4 md:grid md:grid-cols-3">
          <div className="rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
            <div className="text-sm font-semibold text-zinc-950">1. Create the pool</div>
            <p className="mt-2 text-sm leading-6 text-zinc-600">Name the group and get a unique share code that also works as the link.</p>
          </div>
          <div className="rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
            <div className="text-sm font-semibold text-zinc-950">2. Share the square</div>
            <p className="mt-2 text-sm leading-6 text-zinc-600">People can scan the square or paste the link to join on their phone.</p>
          </div>
          <div className="rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-[0_18px_40px_rgba(15,23,42,0.06)]">
            <div className="text-sm font-semibold text-zinc-950">3. Rejoin by name</div>
            <p className="mt-2 text-sm leading-6 text-zinc-600">If your saved details disappear, entering the same name reconnects you to the same pool.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
