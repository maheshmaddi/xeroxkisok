/**
 * Multi-customer OTP verification: two paid jobs waiting at one kiosk.
 * A fake kiosk socket claims by CODE ONLY (as the keypad/agent does) —
 * each digit string must unlock exactly its own job, in any order.
 * Run: node node_modules/ts-node/dist/bin.js --transpile-only scripts/verify-multicode.ts
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const API = 'http://localhost:4000';
const failed: string[] = [];
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failed.push(name);
};

function env(name: string): string | undefined {
  const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : undefined;
}

async function api(path: string, opts: any = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { 'x-job-token': opts.token } : {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function paidJob(name: string) {
  const keySecret = env('RAZORPAY_KEY_SECRET')!;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) doc.addPage([595, 842]).drawText(`multi ${i}`, { x: 60, y: 760, size: 22, font });
  const created = await api('/jobs', { method: 'POST', body: JSON.stringify({ kioskId: 'K001', fileName: name }) });
  const jobId = created.body.jobId;
  const token = new URL(created.body.upload.url).searchParams.get('token');
  await fetch(created.body.upload.url, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: Buffer.from(await doc.save()) });
  await api(`/jobs/${jobId}/process`, { method: 'POST', token });
  await api(`/jobs/${jobId}/price`, {
    method: 'POST', token,
    body: JSON.stringify({ mode: 'document', copies: 1, color: false, duplex: false, paperSize: 'A4' }),
  });
  const paid = await api(`/jobs/${jobId}/pay`, { method: 'POST', token });
  const paymentId = `pay_test_${Date.now().toString(36)}`;
  const signature = createHmac('sha256', keySecret).update(`${paid.body.orderId}|${paymentId}`).digest('hex');
  await api(`/jobs/${jobId}/pay/confirm`, {
    method: 'POST', token,
    body: JSON.stringify({ razorpay_order_id: paid.body.orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }),
  });
  const st = await api(`/jobs/${jobId}/status`, { token });
  return { jobId, token, otp: st.body?.otp as string };
}

function claim(socket: any, payload: object): Promise<any> {
  return new Promise((resolve) => {
    socket.emit('job:claim', payload, (result: any) => resolve(result));
    setTimeout(() => resolve(null), 8000);
  });
}

async function main() {
  console.log('\nMulti-customer OTP — two paid jobs, code-only claims\n');

  // Sweep the user's stranded jobs from earlier testing into refunds.
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['-e', `
    const { PrismaClient } = require('@prisma/client');
    const p = new PrismaClient();
    p.job.updateMany({ where: { state: { in: ['QUEUED','PAID'] }, otpExpiresAt: { gt: new Date() } }, data: { otpExpiresAt: new Date(Date.now() - 60000) } })
      .then(r => { console.log('backdated', r.count, 'stale job(s)'); return p.$disconnect(); });
  `], { stdio: 'inherit' });

  const A = await paidJob('customer-a.pdf');
  const B = await paidJob('customer-b.pdf');
  check('both jobs paid with distinct codes', /^\d{4}$/.test(A.otp) && /^\d{4}$/.test(B.otp) && A.otp !== B.otp, `A=${A.otp} B=${B.otp}`);

  const socket = io(`${API}/kiosk`, { auth: { kioskId: 'K001', secret: 'dev-secret-001' }, transports: ['websocket'] });
  await new Promise<void>((r) => (socket.on('connect', r) as unknown as void, socket.on('connect_error', r) as unknown as void));

  // B arrives at the keypad FIRST — codes must not be order-bound.
  const claimB = await claim(socket, { otp: B.otp });
  check('B\u2019s code claims B\u2019s job', claimB?.ok === true && claimB?.jobId === B.jobId, JSON.stringify(claimB)?.slice(0, 60));
  socket.emit('job:completed', { jobId: B.jobId });

  // A wrong code must not unlock anything.
  const wrong = (A.otp === '0000' ? '9999' : '0000');
  const bad = await claim(socket, { otp: wrong });
  check('wrong code rejected (BAD_OTP)', bad?.ok === false && bad?.error === 'BAD_OTP', JSON.stringify(bad)?.slice(0, 60));

  const claimA = await claim(socket, { otp: A.otp });
  check('A\u2019s code claims A\u2019s job after B', claimA?.ok === true && claimA?.jobId === A.jobId, JSON.stringify(claimA)?.slice(0, 60));
  socket.emit('job:completed', { jobId: A.jobId });

  socket.close();
  await new Promise((r) => setTimeout(r, 1500)); // let completion handlers settle

  const stA = await api(`/jobs/${A.jobId}/status`, { token: A.token });
  const stB = await api(`/jobs/${B.jobId}/status`, { token: B.token });
  check('both jobs COMPLETED', stA.body?.state === 'COMPLETED' && stB.body?.state === 'COMPLETED', `${stA.body?.state}/${stB.body?.state}`);

  console.log(failed.length === 0 ? '\nALL CHECKS PASSED ✅\n' : `\n${failed.length} FAILED ❌ — ${failed.join(', ')}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
