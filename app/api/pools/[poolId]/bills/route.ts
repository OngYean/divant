import { NextResponse } from "next/server";
import {
	loadSessionFromCookieValue,
	readSessionCookie,
	createBillWithShares,
	loadPoolBills,
	type BillShare,
} from "@/lib/pool-service";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ poolId: string }> }) {
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

		const body = await request.json() as {
			title?: string;
			totalAmount?: number;
			currency?: string;
			splitMode?: "equal" | "custom" | "fixed";
			shares?: Array<{ userId: string; shareAmount: number; shareValue?: number }>;
		};

		if (!body.title || !body.totalAmount || !body.splitMode || !body.shares || body.shares.length === 0) {
			return NextResponse.json({ error: "Invalid bill data" }, { status: 400 });
		}

		const bill = await createBillWithShares(
			poolId,
			session.userId,
			body.title,
			body.totalAmount,
			body.currency || "USD",
			body.splitMode,
			body.shares as BillShare[],
		);

		// Broadcast to WebSocket subscribers
		const wsBrokerUrl = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
		await fetch(`${wsBrokerUrl}/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "bill_created", poolId }),
		}).catch((e) => console.error("WS broadcast failed:", e));

		return NextResponse.json({ ok: true, bill }, { status: 201 });
	} catch (error) {
		console.error("Create bill error:", error);
		return NextResponse.json({ error: "Failed to create bill" }, { status: 500 });
	}
}

export async function GET(request: Request, { params }: { params: Promise<{ poolId: string }> }) {
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

		const bills = await loadPoolBills(poolId);
		return NextResponse.json({ ok: true, bills }, { status: 200 });
	} catch (error) {
		console.error("Load bills error:", error);
		return NextResponse.json({ error: "Failed to load bills" }, { status: 500 });
	}
}
