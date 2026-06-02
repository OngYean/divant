import { NextResponse } from "next/server";

import { POOL_SESSION_COOKIE_MAX_AGE, POOL_SESSION_COOKIE_NAME, ensureMySqlSchema } from "../../../../../lib/mysql";
import { buildSessionCookieValue, joinPoolWithName, setUserPaymentLink } from "../../../../../lib/pool-service";

export const runtime = "nodejs";

type JoinBody = {
	name?: unknown;
	paymentLink?: unknown;
};

function setSessionCookie(response: NextResponse, session: { poolId: string; userId: string; sessionToken: string }) {
	response.cookies.set({
		name: POOL_SESSION_COOKIE_NAME,
		value: buildSessionCookieValue(session),
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: process.env.NODE_ENV === "production",
		maxAge: POOL_SESSION_COOKIE_MAX_AGE,
	});
}

export async function POST(request: Request, context: { params: Promise<{ poolId: string }> }) {
	try {
		const { poolId } = await context.params;
		const body = (await request.json().catch(() => ({}))) as JoinBody;
		const name = typeof body.name === "string" ? body.name : "";
		const paymentLink = typeof body.paymentLink === "string" ? body.paymentLink.trim() : null;

		if (!name.trim()) {
			return NextResponse.json({ ok: false, message: "Your name is required." }, { status: 400 });
		}

		await ensureMySqlSchema();
		const joined = await joinPoolWithName(poolId, name);
		if (paymentLink) {
			await setUserPaymentLink(joined.member.id, paymentLink);
			joined.member.paymentLink = paymentLink;
		}
		const response = NextResponse.json({ ok: true, ...joined }, { status: 200 });
		setSessionCookie(response, joined.session);

		// notify websocket broker about the new member
		try {
			const broker = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
			void fetch(`${broker}/broadcast`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "member_joined", poolId: joined.pool.id, member: joined.member }),
			});
		} catch {}
		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to join the pool.";
		const status = message.includes("not found") ? 404 : message.includes("expired") ? 410 : 503;
		return NextResponse.json({ ok: false, message }, { status });
	}
}