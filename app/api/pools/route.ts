import { NextResponse } from "next/server";

import { POOL_SESSION_COOKIE_MAX_AGE, POOL_SESSION_COOKIE_NAME, ensureMySqlSchema } from "../../../lib/mysql";
import { buildSessionCookieValue, createPoolWithOwner } from "../../../lib/pool-service";

export const runtime = "nodejs";

type CreatePoolBody = {
	poolName?: unknown;
	ownerName?: unknown;
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

export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as CreatePoolBody;
		const poolName = typeof body.poolName === "string" ? body.poolName : "";
		const ownerName = typeof body.ownerName === "string" ? body.ownerName : "";

		if (!poolName.trim() || !ownerName.trim()) {
			return NextResponse.json({ ok: false, message: "Pool name and your name are required." }, { status: 400 });
		}

		await ensureMySqlSchema();
		const created = await createPoolWithOwner(poolName, ownerName);
		const response = NextResponse.json({ ok: true, ...created }, { status: 201 });
		setSessionCookie(response, created.session);

		// notify websocket broker about the new owner/member
		try {
			const broker = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
			void fetch(`${broker}/broadcast`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "member_joined", poolId: created.pool.id, member: created.member }),
			});
		} catch {}
		return response;
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				message: error instanceof Error ? error.message : "Failed to create the pool.",
			},
			{ status: 503 },
		);
	}
}