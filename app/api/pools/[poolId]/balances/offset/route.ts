import { NextResponse } from "next/server";
import {
	loadSessionFromCookieValue,
	readSessionCookie,
	cancelOffsettingDebts,
} from "@/lib/pool-service";

export const runtime = "nodejs";

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ poolId: string }> },
) {
	const { poolId } = await params;

	const session = await readSessionCookie();
	if (!session) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const active = await loadSessionFromCookieValue(session);
		if (!active || active.pool.id !== poolId) {
			return NextResponse.json({ error: "Pool not found or access denied" }, { status: 403 });
		}

		const body = await request.json() as { partnerId: string };
		if (!body.partnerId || typeof body.partnerId !== "string") {
			return NextResponse.json({ error: "Invalid partnerId" }, { status: 400 });
		}

		await cancelOffsettingDebts(poolId, active.member.id, body.partnerId);

		// Broadcast to WebSocket subscribers
		const wsBrokerUrl = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
		await fetch(`${wsBrokerUrl}/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "bill_updated", poolId }),
		}).catch((e) => console.error("WS broadcast failed:", e));

		return NextResponse.json({ ok: true }, { status: 200 });
	} catch (error) {
		console.error("Offset debts error:", error);
		return NextResponse.json({ error: "Failed to offset mutual debts" }, { status: 500 });
	}
}
