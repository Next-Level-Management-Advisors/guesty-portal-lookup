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
const NOT_PROVISIONED_UNPUBLISHED_MSG =
  "We found your reservation, but your guest portal isn't ready yet. Please contact your host to publish the guest app for this stay.";

function tooFarOutMessage(checkIn?: string): string {
  if (checkIn) {
    const t = Date.parse(checkIn);
    if (!Number.isNaN(t)) {
      const formatted = new Date(t).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      return `We found your reservation for ${formatted}. Your guest portal opens about a week before check-in — please come back then.`;
    }
  }
  return 'We found your reservation. Your guest portal opens about a week before check-in — please come back then.';
}

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

    const dynamicVar = await resolveGuestAppToken(id, accountSlug, reservation.checkIn);
    const url = buildGuestAppUrl(id, dynamicVar);
    return NextResponse.json({ ok: true, url });
  } catch (e) {
    if (e instanceof GuestAppNotProvisionedError) {
      const error =
        e.reason === 'too-far-out' ? tooFarOutMessage(e.checkIn) : NOT_PROVISIONED_UNPUBLISHED_MSG;
      return NextResponse.json({ ok: false, error }, { status: 503 });
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
