export default function Page() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6">
      <h1 className="text-2xl font-bold">Print Kiosk — Admin</h1>
      <p className="mt-3 text-slate-400">
        The dashboard (kiosk map, ink &amp; paper levels, revenue, refunds, remote commands, Telegram alerts) is
        built in <span className="font-semibold text-slate-200">Phase 5</span> per the spec. The kiosk + job APIs
        it will consume are live in the API app.
      </p>
      <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        Phase 1 status: core pipeline — upload → price → mock-pay → OTP → print (simulator) → file deletion.
      </div>
    </main>
  );
}
