import { NextResponse } from 'next/server';
import {
  findReservationByCode,
  resolveGuestAppToken,
  GuestyError,
  GuestAppNotProvisionedError,
} from '@/lib/guesty';
import { buildGuestAppUrl } from '@/lib/guest-app-url';

export const dynamic = 'force-dynamic';

const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

const NOT_FOUND_MSG = "We couldn't find that reservation. Double-check the code and try again.";
const NOT_PROVISIONED_MSG =
  "We found your reservation, but your guest portal isn't ready yet. Please contact your host to publish the guest app for this stay.";

export async function POST(req: Request) {
  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const code = body.code?.trim();
  if (!code || !CODE_RE.test(code)) {
    return NextResponse.json({ ok: false, error: 'Enter your reservation code.' }, { status: 400 });
  }

  const accountSlug = process.env.GUESTY_ACCOUNT_SLUG;
  if (!accountSlug) {
    return NextResponse.json(
      { ok: false, error: 'Server is not configured. Please contact your host.' },
      { status: 503 },
    );
  }

  try {
    const reservation = await findReservationByCode(code);
    const id = reservation?._id ?? reservation?.id;
    if (!reservation || !id) {
      return NextResponse.json({ ok: false, error: NOT_FOUND_MSG }, { status: 404 });
    }

    const dynamicVar = await resolveGuestAppToken(id, accountSlug);
    const url = buildGuestAppUrl(id, dynamicVar);
    return NextResponse.json({ ok: true, url });
  } catch (e) {
    if (e instanceof GuestAppNotProvisionedError) {
      return NextResponse.json({ ok: false, error: NOT_PROVISIONED_MSG }, { status: 503 });
    }
    console.error('lookup failed', e);
    if (e instanceof GuestyError && (e.status === 404 || e.status === 410 || e.status === 400)) {
      return NextResponse.json({ ok: false, error: NOT_FOUND_MSG }, { status: 404 });
    }
    if (e instanceof Error && /GUESTY_OPEN_API/.test(e.message)) {
      return NextResponse.json(
        { ok: false, error: 'Reservation lookup is temporarily unavailable. Please contact your host.' },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Something went wrong. Please try again.' },
      { status: e instanceof GuestyError ? e.status : 500 },
    );
  }
}
