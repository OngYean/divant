import { NextResponse } from "next/server";
import {
	loadSessionFromCookieValue,
	readSessionCookie,
	loadBill,
	updateBill,
	deleteBill,
	type BillShare,
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

		// Verify bill exists and belongs to this pool
		const bill = await loadBill(billIdNum);
		if (!bill || bill.poolId !== poolId) {
			return NextResponse.json({ error: "Bill not found" }, { status: 404 });
		}
		// Only the bill creator can edit the bill
		if (active.member.id !== bill.createdByUserId) {
			return NextResponse.json({ error: "Only the bill owner can edit" }, { status: 403 });
		}
		// Disallow editing if any share has already been paid
		if (bill.shares.some((s) => s.isPaid)) {
			return NextResponse.json({ error: "Cannot edit bill after any share is paid" }, { status: 403 });
		}
		/* Duplicate edit checks removed */

		const body = await request.json() as {
			title?: string;
			totalAmount?: number;
			splitMode?: "equal" | "custom" | "fixed";
			shares?: Array<{ userId: string; shareAmount: number; shareValue?: number }>;
		};

		if (!body.title || !body.totalAmount || !body.splitMode || !body.shares || body.shares.length === 0) {
			return NextResponse.json({ error: "Invalid bill data" }, { status: 400 });
		}

		const updatedBill = await updateBill(billIdNum, body.title, body.totalAmount, body.splitMode, body.shares as BillShare[]);

		// Broadcast to WebSocket subscribers
		const wsBrokerUrl = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
		await fetch(`${wsBrokerUrl}/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "bill_updated", poolId }),
		}).catch((e) => console.error("WS broadcast failed:", e));

		return NextResponse.json({ ok: true, bill: updatedBill }, { status: 200 });
	} catch (error) {
		console.error("Update bill error:", error);
		return NextResponse.json({ error: "Failed to update bill" }, { status: 500 });
	}
}

export async function DELETE(
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

		// Verify bill exists and belongs to this pool
		const bill = await loadBill(billIdNum);
		if (!bill || bill.poolId !== poolId) {
			return NextResponse.json({ error: "Bill not found" }, { status: 404 });
		}

		// Verify ownership: only bill creator can delete
		if (active.member.id !== bill.createdByUserId) {
			return NextResponse.json({ error: "Only the bill owner can delete" }, { status: 403 });
		}
		// Disallow deletion unless all shares are paid
		if (!bill.shares.every((s) => s.isPaid)) {
			return NextResponse.json({ error: "Cannot delete bill unless all shares are paid" }, { status: 403 });
		}

		await deleteBill(billIdNum);

		// Broadcast to WebSocket subscribers
		const wsBrokerUrl = process.env.WS_BROKER_HTTP_URL || "http://127.0.0.1:3002";
		await fetch(`${wsBrokerUrl}/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "bill_deleted", poolId }),
		}).catch((e) => console.error("WS broadcast failed:", e));

		return NextResponse.json({ ok: true }, { status: 200 });
	} catch (error) {
		console.error("Delete bill error:", error);
		return NextResponse.json({ error: "Failed to delete bill" }, { status: 500 });
	}
}
