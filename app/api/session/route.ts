import { NextResponse } from "next/server";

import { POOL_SESSION_COOKIE_NAME } from "../../../lib/mysql";
import { loadSessionFromCookieValue, readSessionCookie, deleteUserWithSession, getPoolUserCount } from "../../../lib/pool-service";

export const runtime = "nodejs";

export async function GET() {
	const session = await readSessionCookie();
	if (!session) {
		return NextResponse.json({ ok: true, session: null }, { status: 200 });
	}

	try {
		const active = await loadSessionFromCookieValue(session);
		if (!active) {
			const response = NextResponse.json({ ok: true, session: null }, { status: 200 });
			response.cookies.delete(POOL_SESSION_COOKIE_NAME);
			return response;
		}

		return NextResponse.json({ ok: true, session: active }, { status: 200 });
	} catch {
		const response = NextResponse.json({ ok: true, session: null }, { status: 200 });
		response.cookies.delete(POOL_SESSION_COOKIE_NAME);
		return response;
	}
}

export async function DELETE(request: Request) {
	// attempt to load current session to broadcast a leave
	try {
		const session = await readSessionCookie();
		if (session) {
			const active = await loadSessionFromCookieValue(session);
			if (active) {
				// check if this is the last user
				let usersCount = 0;
				try {
					usersCount = await getPoolUserCount(active.pool.id);
				} catch {}

				const body = await request.json().catch(() => ({}));
				const confirm = Boolean(body?.confirm);

				if (usersCount <= 1 && !confirm) {
					return NextResponse.json({ ok: true, warning: "last_user", usersCount }, { status: 200 });
				}

				// delete the user row for this session, then broadcast the leave
				try {
					await deleteUserWithSession(session);
				} catch {}
				try {
					const broker = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
					void fetch(`${broker}/broadcast`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ type: "member_left", poolId: active.pool.id, member: active.member }),
					});
				} catch {}
			}
		}
	} catch {}

	const response = NextResponse.json({ ok: true }, { status: 200 });
	response.cookies.delete(POOL_SESSION_COOKIE_NAME);
	return response;
}