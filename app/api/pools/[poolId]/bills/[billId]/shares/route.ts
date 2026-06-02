import { NextResponse } from "next/server";
import {
	loadSessionFromCookieValue,
	readSessionCookie,
	loadBill,
	setBillSharePaidStatus,
} from "@/lib/pool-service";

export const runtime = "nodejs";

export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ poolId: string; billId: string }> },
) {
	const { poolId, billId } = await params;
	const billIdNum = parseInt(billId, 10);
	if (isNaN(billIdNum)) {
		return NextResponse.json({ error: "Invalid bill ID" }, { status: 400 });
	}

	const session = await readSessionCookie();
	if (!session) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		const active = await loadSessionFromCookieValue(session);
		if (!active || active.pool.id !== poolId) {
			return NextResponse.json({ error: "Pool not found or access denied" }, { status: 403 });
		}

		const bill = await loadBill(billIdNum);
		if (!bill || bill.poolId !== poolId) {
			return NextResponse.json({ error: "Bill not found" }, { status: 404 });
		}

		const body = await request.json() as { isPaid: boolean; userId?: string; resetOffset?: boolean };
		if (typeof body.isPaid !== "boolean") {
			return NextResponse.json({ error: "isPaid must be a boolean" }, { status: 400 });
		}

		const targetUserId = body.userId || active.member.id;

		// Only allow toggling own share status, or allowing the bill creator to toggle other shares
		if (targetUserId !== active.member.id && active.member.id !== bill.createdByUserId) {
			return NextResponse.json({ error: "Not authorized to update this user's share status" }, { status: 403 });
		}

		await setBillSharePaidStatus(billIdNum, targetUserId, body.isPaid, body.resetOffset);

		// Broadcast to WebSocket subscribers
		const wsBrokerUrl = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
		await fetch(`${wsBrokerUrl}/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "bill_updated", poolId }),
		}).catch((e) => console.error("WS broadcast failed:", e));

		return NextResponse.json({ ok: true }, { status: 200 });
	} catch (error) {
		console.error("Update share status error:", error);
		return NextResponse.json({ error: "Failed to update share status" }, { status: 500 });
	}
}
