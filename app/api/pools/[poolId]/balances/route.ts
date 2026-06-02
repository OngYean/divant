import { NextResponse } from "next/server";
import { loadSessionFromCookieValue, readSessionCookie, calculatePoolBalances } from "@/lib/pool-service";
import { ensureMySqlSchema } from "@/lib/mysql";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ poolId: string }> }) {
	const { poolId } = await params;
	const session = await readSessionCookie();

	if (!session) {
		return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
	}

	try {
		await ensureMySqlSchema();
		const active = await loadSessionFromCookieValue(session);
		if (!active || active.pool.id !== poolId) {
			return NextResponse.json({ error: "Pool not found or access denied" }, { status: 403 });
		}

		const balances = await calculatePoolBalances(poolId);
		return NextResponse.json({ ok: true, balances }, { status: 200 });
	} catch (error) {
		console.error("Load balances error:", error);
		return NextResponse.json({ error: "Failed to load balances" }, { status: 500 });
	}
}
