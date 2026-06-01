import { NextResponse } from "next/server";

import { POOL_SESSION_COOKIE_NAME, ensureMySqlSchema } from "../../../../lib/mysql";
import { deletePoolWithSession, readSessionCookie } from "../../../../lib/pool-service";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: { params: Promise<{ poolId: string }> }) {
	void request;

	try {
		const { poolId } = await context.params;
		const session = await readSessionCookie();
		if (!session || session.poolId !== poolId) {
			return NextResponse.json({ ok: false, message: "You are not signed in to this pool." }, { status: 401 });
		}

		await ensureMySqlSchema();
		await deletePoolWithSession(session);
		// notify websocket broker about deletion
		try {
			const broker = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
			void fetch(`${broker}/broadcast`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ type: "pool_deleted", poolId }),
			});
		} catch {}

		const response = NextResponse.json({ ok: true }, { status: 200 });
		response.cookies.delete(POOL_SESSION_COOKIE_NAME);
		return response;
	} catch (error) {
		return NextResponse.json(
			{
				ok: false,
				message: error instanceof Error ? error.message : "Failed to delete the pool.",
			},
			{ status: 503 },
		);
	}
}