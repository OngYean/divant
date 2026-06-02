import "server-only";

import { cookies } from "next/headers";

import {
	POOL_SESSION_COOKIE_NAME,
	createMemberId,
	createPoolId,
	createSessionToken,
	getPoolTimeoutMs,
	hashSessionToken,
	getMySqlPool,
	normalizeMemberName,
	type SessionCookieValue,
} from "./mysql";

export type PoolMemberRecord = {
	id: string;
	name: string;
	normalizedName: string;
	joinedAt: string;
	lastSeenAt: string;
	isOwner: boolean;
};

export type PoolRecord = {
	id: string;
	name: string;
	createdAt: string;
	lastActiveAt: string;
	expiresAt: string;
	members: PoolMemberRecord[];
};

export type CurrentSessionRecord = {
	pool: PoolRecord;
	member: PoolMemberRecord;
};

function toIsoTimestamp(value: unknown) {
	if (value instanceof Date) {
		return value.toISOString();
	}

	if (typeof value === "string") {
		return new Date(value).toISOString();
	}

	return new Date(String(value)).toISOString();
}

function isPoolExpired(expiresAt: unknown) {
	return new Date(String(expiresAt)).getTime() <= Date.now();
}

export async function loadPoolRecord(poolId: string) {
	const pool = getMySqlPool();
	if (!pool) {
		return null;
	}

	const [poolRows] = await pool.query(
		"SELECT id, name, created_at, last_active_at, expires_at FROM `pool` WHERE id = ? LIMIT 1",
		[poolId],
	);
	const records = poolRows as Array<Record<string, unknown>>;
	const poolRow = records[0];

	if (!poolRow || isPoolExpired(poolRow.expires_at)) {
		return null;
	}

	const [memberRows] = await pool.query(
		"SELECT id, name, normalized_name, joined_at, last_seen_at, is_owner FROM `user` WHERE pool_id = ? ORDER BY is_owner DESC, joined_at ASC",
		[poolId],
	);

	const members = (memberRows as Array<Record<string, unknown>>).map((row) => ({
		id: String(row.id),
		name: String(row.name),
		normalizedName: String(row.normalized_name),
		joinedAt: toIsoTimestamp(row.joined_at),
		lastSeenAt: toIsoTimestamp(row.last_seen_at),
		isOwner: Number(row.is_owner) === 1,
	}));

		return {
			id: String(poolRow.id),
			name: String(poolRow.name),
			createdAt: toIsoTimestamp(poolRow.created_at),
			lastActiveAt: toIsoTimestamp(poolRow.last_active_at),
			expiresAt: toIsoTimestamp(poolRow.expires_at),
			members,
		};
}

async function loadCurrentSession(session: SessionCookieValue) {
	const pool = getMySqlPool();
	if (!pool) {
		return null;
	}

	const sessionTokenHash = hashSessionToken(session.sessionToken);
	const [rows] = await pool.query(
		"SELECT p.id AS pool_id FROM `pool` p INNER JOIN `user` u ON u.pool_id = p.id WHERE p.id = ? AND u.id = ? AND u.session_token_hash = ? LIMIT 1",
		[session.poolId, session.userId, sessionTokenHash],
	);
	const matches = rows as Array<Record<string, unknown>>;
	if (!matches[0]) {
		return null;
	}

	await pool.query("UPDATE `user` SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [session.userId]);
	await pool.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [session.poolId]);

	const poolRecord = await loadPoolRecord(session.poolId);
	if (!poolRecord) {
		return null;
	}

	const member = poolRecord.members.find((entry) => entry.id === session.userId) ?? null;
	if (!member) {
		return null;
	}

	return {
		pool: poolRecord,
		member,
	};
}

export async function readSessionCookie() {
	const cookieStore = await cookies();
	const rawCookie = cookieStore.get(POOL_SESSION_COOKIE_NAME)?.value;
	if (!rawCookie) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawCookie) as Partial<SessionCookieValue>;
		if (!parsed.poolId || !parsed.userId || !parsed.sessionToken) {
			return null;
		}

		return {
			poolId: parsed.poolId,
			userId: parsed.userId,
			sessionToken: parsed.sessionToken,
		} satisfies SessionCookieValue;
	} catch {
		return null;
	}
}

export function clearSessionCookieCookie() {
	return {
		name: POOL_SESSION_COOKIE_NAME,
		value: "",
		maxAge: 0,
		path: "/",
	};
}

export function buildSessionCookieValue(session: SessionCookieValue) {
	return JSON.stringify(session);
}

export async function createPoolWithOwner(poolName: string, ownerName: string) {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const normalizedPoolName = poolName.trim();
	const normalizedOwnerName = ownerName.trim();
	if (!normalizedPoolName || !normalizedOwnerName) {
		throw new Error("Pool name and your name are required.");
	}

	const poolId = createPoolId();
	const userId = createMemberId();
	const sessionToken = createSessionToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + getPoolTimeoutMs());
	const sessionTokenHash = hashSessionToken(sessionToken);
	const connection = await pool.getConnection();

	try {
		await connection.beginTransaction();
		await connection.query(
			"INSERT INTO `pool` (id, name, created_at, last_active_at, expires_at) VALUES (?, ?, ?, ?, ?)",
			[poolId, normalizedPoolName, now, now, expiresAt],
		);
		await connection.query(
			"INSERT INTO `user` (id, pool_id, name, normalized_name, session_token_hash, is_owner, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
			[userId, poolId, normalizedOwnerName, normalizeMemberName(normalizedOwnerName), sessionTokenHash, now, now],
		);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}

	const session = await loadCurrentSession({ poolId, userId, sessionToken });
	if (!session) {
		throw new Error("Failed to load the newly created pool.");
	}

	return {
		...session,
		session: { poolId, userId, sessionToken },
	};
}

export async function joinPoolWithName(poolId: string, memberName: string) {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const normalizedPoolId = poolId.trim().toUpperCase();
	const normalizedMemberName = memberName.trim();
	if (!normalizedPoolId || !normalizedMemberName) {
		throw new Error("Pool code and your name are required.");
	}

	const normalizedLookupName = normalizeMemberName(normalizedMemberName);
	const sessionToken = createSessionToken();
	const sessionTokenHash = hashSessionToken(sessionToken);
	const now = new Date();
	const connection = await pool.getConnection();
	let memberId = "";

	try {
		await connection.beginTransaction();
		const [poolRows] = await connection.query(
			"SELECT id, expires_at FROM `pool` WHERE id = ? LIMIT 1 FOR UPDATE",
			[normalizedPoolId],
		);
		const poolRecords = poolRows as Array<Record<string, unknown>>;
		const poolRow = poolRecords[0];

		if (!poolRow) {
			throw new Error("Pool not found.");
		}

		if (isPoolExpired(poolRow.expires_at)) {
			await connection.rollback();
			throw new Error("This pool has expired.");
		}

		const [memberRows] = await connection.query(
			"SELECT id FROM `user` WHERE pool_id = ? AND normalized_name = ? LIMIT 1 FOR UPDATE",
			[normalizedPoolId, normalizedLookupName],
		);
		const memberRecords = memberRows as Array<Record<string, unknown>>;
		const existingMember = memberRecords[0];
		memberId = String(existingMember?.id ?? "");

		if (existingMember) {
			await connection.query(
				"UPDATE `user` SET name = ?, session_token_hash = ?, last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
				[normalizedMemberName, sessionTokenHash, memberId],
			);
		} else {
			memberId = createMemberId();
			await connection.query(
				"INSERT INTO `user` (id, pool_id, name, normalized_name, session_token_hash, is_owner, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
				[memberId, normalizedPoolId, normalizedMemberName, normalizedLookupName, sessionTokenHash, now, now],
			);
		}

		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [normalizedPoolId]);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}

	const poolRecord = await loadPoolRecord(normalizedPoolId);

	if (!poolRecord) {
		throw new Error("Failed to load the joined pool.");
	}

	const member = poolRecord.members.find((entry) => entry.id === memberId);

	if (!member) {
		throw new Error("Failed to load the joined member.");
	}

	return {
		pool: poolRecord,
		member,
		session: { poolId: normalizedPoolId, userId: member.id, sessionToken },
	};
}

export async function loadSessionFromCookieValue(session: SessionCookieValue) {
	return loadCurrentSession(session);
}

export async function getPoolUserCount(poolId: string) {
	const pool = getMySqlPool();
 	if (!pool) {
 		throw new Error("Database connection is not available.");
 	}

	const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM `user` WHERE pool_id = ?", [poolId]);
	const records = rows as Array<Record<string, unknown>>;
	return Number(records[0]?.cnt ?? 0);
}

export async function deleteUserWithSession(session: SessionCookieValue) {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const sessionTokenHash = hashSessionToken(session.sessionToken);
	const connection = await pool.getConnection();

	try {
		await connection.beginTransaction();
		// verify the user/session matches
		const [rows] = await connection.query(
			"SELECT id FROM `user` WHERE id = ? AND pool_id = ? AND session_token_hash = ? LIMIT 1 FOR UPDATE",
			[session.userId, session.poolId, sessionTokenHash],
		);
		const records = rows as Array<Record<string, unknown>>;
		if (!records[0]) {
			await connection.rollback();
			return false;
		}

		await connection.query("DELETE FROM `user` WHERE id = ?", [session.userId]);

		// if no users remain for this pool, delete the pool as well
		const [countRows] = await connection.query("SELECT COUNT(*) AS cnt FROM `user` WHERE pool_id = ?", [session.poolId]);
		const cnt = Number(((countRows as Array<Record<string, unknown>>)[0]?.cnt) ?? 0);
		if (cnt === 0) {
			await connection.query("DELETE FROM `pool` WHERE id = ?", [session.poolId]);
		} else {
			await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [session.poolId]);
		}
		await connection.commit();
		return true;
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function deletePoolWithSession(session: SessionCookieValue) {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const sessionTokenHash = hashSessionToken(session.sessionToken);
	const connection = await pool.getConnection();

	try {
		await connection.beginTransaction();
		const [rows] = await connection.query(
			"SELECT u.is_owner FROM `pool` p INNER JOIN `user` u ON u.pool_id = p.id WHERE p.id = ? AND u.id = ? AND u.session_token_hash = ? LIMIT 1 FOR UPDATE",
			[session.poolId, session.userId, sessionTokenHash],
		);
		const records = rows as Array<Record<string, unknown>>;
		if (!records[0] || Number(records[0].is_owner) !== 1) {
			throw new Error("Only the owner can delete this pool.");
		}

		await connection.query("DELETE FROM `pool` WHERE id = ?", [session.poolId]);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export function getClientSessionCookieName() {
	return POOL_SESSION_COOKIE_NAME;
}

// Bill types
export type BillShare = {
	userId: string;
	shareAmount: number;
	shareValue?: number;
	isPaid?: boolean;
	offsetAmount?: number;
	paidAt?: string;
};

export type Bill = {
	id: number;
	poolId: string;
	createdByUserId: string;
	title: string;
	totalAmount: number;
	currency: string;
	splitMode: "equal" | "custom" | "fixed";
	shares: BillShare[];
	createdAt: string;
	updatedAt: string;
};

export type UserBalance = {
	userId: string;
	owes: Array<{ toUserId: string; amount: number }>;
	owed: Array<{ fromUserId: string; amount: number }>;
};

export async function createBillWithShares(
	poolId: string,
	createdByUserId: string,
	title: string,
	totalAmount: number,
	currency: string,
	splitMode: "equal" | "custom" | "fixed",
	shares: BillShare[],
): Promise<Bill> {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const connection = await pool.getConnection();
	const now = new Date();
	let billId: number = 0;

	try {
		await connection.beginTransaction();

		// Insert bill
		const [insertResult] = await connection.query(
			"INSERT INTO `bill` (pool_id, created_by_user_id, title, total_amount, currency, split_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[poolId, createdByUserId, title, totalAmount, currency, splitMode, now, now],
		);
		billId = (insertResult as { insertId: number }).insertId;

		// Insert bill shares
		for (const share of shares) {
			await connection.query(
				"INSERT INTO `bill_share` (bill_id, user_id, share_type, share_value, share_amount) VALUES (?, ?, ?, ?, ?)",
				[billId, share.userId, splitMode, share.shareValue || null, share.shareAmount],
			);
		}

		// Update pool last_active_at
		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [poolId]);

		await connection.commit();

		return {
			id: billId,
			poolId,
			createdByUserId,
			title,
			totalAmount,
			currency,
			splitMode,
			shares,
			createdAt: now.toISOString(),
			updatedAt: now.toISOString(),
		};
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function loadBill(billId: number): Promise<Bill | null> {
	const pool = getMySqlPool();
	if (!pool) {
		return null;
	}

	const [billRows] = await pool.query(
		"SELECT id, pool_id, created_by_user_id, title, total_amount, currency, split_mode, created_at, updated_at FROM `bill` WHERE id = ? LIMIT 1",
		[billId],
	);
	const billRecords = billRows as Array<Record<string, unknown>>;
	const billRow = billRecords[0];

	if (!billRow) {
		return null;
	}

	const [shareRows] = await pool.query(
		"SELECT user_id, share_type, share_value, share_amount, is_paid, offset_amount, paid_at FROM `bill_share` WHERE bill_id = ?",
		[billId],
	);
	const shareRecords = shareRows as Array<Record<string, unknown>>;
	const shares = shareRecords.map((row) => ({
		userId: String(row.user_id),
		shareAmount: parseFloat(String(row.share_amount)),
		shareValue: row.share_value ? parseFloat(String(row.share_value)) : undefined,
		isPaid: Number(row.is_paid) === 1,
		offsetAmount: row.offset_amount ? parseFloat(String(row.offset_amount)) : 0,
		paidAt: row.paid_at ? toIsoTimestamp(row.paid_at) : undefined,
	}));

	return {
		id: Number(billRow.id),
		poolId: String(billRow.pool_id),
		createdByUserId: String(billRow.created_by_user_id),
		title: String(billRow.title),
		totalAmount: parseFloat(String(billRow.total_amount)),
		currency: String(billRow.currency),
		splitMode: String(billRow.split_mode) as "equal" | "custom" | "fixed",
		shares,
		createdAt: toIsoTimestamp(billRow.created_at),
		updatedAt: toIsoTimestamp(billRow.updated_at),
	};
}

export async function loadPoolBills(poolId: string): Promise<Bill[]> {
	const pool = getMySqlPool();
	if (!pool) {
		return [];
	}

	const [billRows] = await pool.query(
		"SELECT id, pool_id, created_by_user_id, title, total_amount, currency, split_mode, created_at, updated_at FROM `bill` WHERE pool_id = ? ORDER BY created_at DESC",
		[poolId],
	);
	const billRecords = billRows as Array<Record<string, unknown>>;

	const bills: Bill[] = [];
	for (const billRow of billRecords) {
		const [shareRows] = await pool.query(
			"SELECT user_id, share_type, share_value, share_amount, is_paid, offset_amount, paid_at FROM `bill_share` WHERE bill_id = ?",
			[billRow.id],
		);
		const shareRecords = shareRows as Array<Record<string, unknown>>;
		const shares = shareRecords.map((row) => ({
			userId: String(row.user_id),
			shareAmount: parseFloat(String(row.share_amount)),
			shareValue: row.share_value ? parseFloat(String(row.share_value)) : undefined,
			isPaid: Number(row.is_paid) === 1,
			offsetAmount: row.offset_amount ? parseFloat(String(row.offset_amount)) : 0,
			paidAt: row.paid_at ? toIsoTimestamp(row.paid_at) : undefined,
		}));

		bills.push({
			id: Number(billRow.id),
			poolId: String(billRow.pool_id),
			createdByUserId: String(billRow.created_by_user_id),
			title: String(billRow.title),
			totalAmount: parseFloat(String(billRow.total_amount)),
			currency: String(billRow.currency),
			splitMode: String(billRow.split_mode) as "equal" | "custom" | "fixed",
			shares,
			createdAt: toIsoTimestamp(billRow.created_at),
			updatedAt: toIsoTimestamp(billRow.updated_at),
		});
	}

	return bills;
}

export async function updateBill(
	billId: number,
	title: string,
	totalAmount: number,
	splitMode: "equal" | "custom" | "fixed",
	shares: BillShare[],
): Promise<Bill> {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const bill = await loadBill(billId);
	if (!bill) {
		throw new Error("Bill not found.");
	}

	const connection = await pool.getConnection();
	const now = new Date();

	try {
		await connection.beginTransaction();

		// Update bill
		await connection.query(
			"UPDATE `bill` SET title = ?, total_amount = ?, split_mode = ?, updated_at = ? WHERE id = ?",
			[title, totalAmount, splitMode, now, billId],
		);

		// Delete old shares
		await connection.query("DELETE FROM `bill_share` WHERE bill_id = ?", [billId]);

		// Insert new shares
		for (const share of shares) {
			await connection.query(
				"INSERT INTO `bill_share` (bill_id, user_id, share_type, share_value, share_amount) VALUES (?, ?, ?, ?, ?)",
				[billId, share.userId, splitMode, share.shareValue || null, share.shareAmount],
			);
		}

		// Update pool last_active_at
		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [bill.poolId]);

		await connection.commit();

		return {
			id: billId,
			poolId: bill.poolId,
			createdByUserId: bill.createdByUserId,
			title,
			totalAmount,
			currency: bill.currency,
			splitMode,
			shares,
			createdAt: bill.createdAt,
			updatedAt: now.toISOString(),
		};
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function deleteBill(billId: number): Promise<void> {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const bill = await loadBill(billId);
	if (!bill) {
		throw new Error("Bill not found.");
	}

	const connection = await pool.getConnection();

	try {
		await connection.beginTransaction();

		// Delete bill (shares cascade delete)
		await connection.query("DELETE FROM `bill` WHERE id = ?", [billId]);

		// Update pool last_active_at
		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [bill.poolId]);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}

export async function calculatePoolBalances(poolId: string): Promise<Record<string, UserBalance>> {
	const pool = getMySqlPool();
	if (!pool) {
		return {};
	}

	// Get all bills for the pool
	const [billRows] = await pool.query(
		"SELECT id FROM `bill` WHERE pool_id = ?",
		[poolId],
	);
	const billRecords = billRows as Array<Record<string, unknown>>;
	const billIds = billRecords.map((b) => Number(b.id));

	// Initialize balances for all users in pool
	const [userRows] = await pool.query(
		"SELECT id FROM `user` WHERE pool_id = ?",
		[poolId],
	);
	const userRecords = userRows as Array<Record<string, unknown>>;
	const balances: Record<string, UserBalance> = {};
	for (const user of userRecords) {
		const userId = String(user.id);
		balances[userId] = { userId, owes: [], owed: [] };
	}

	// Calculate balances from shares
	for (const billId of billIds) {
		const bill = await loadBill(billId);
		if (!bill) continue;

		// For each share, the user owes the bill creator
		for (const share of bill.shares) {
			if (share.isPaid) continue;
			const shareAmount = share.shareAmount - (share.offsetAmount || 0);
			if (shareAmount <= 0) continue;

			// Track who owes whom
			if (!balances[share.userId]) {
				balances[share.userId] = { userId: share.userId, owes: [], owed: [] };
			}
			if (!balances[bill.createdByUserId]) {
				balances[bill.createdByUserId] = { userId: bill.createdByUserId, owes: [], owed: [] };
			}

			// Add to owes list
			const existingOwe = balances[share.userId].owes.find((o) => o.toUserId === bill.createdByUserId);
			if (existingOwe) {
				existingOwe.amount += shareAmount;
			} else {
				balances[share.userId].owes.push({ toUserId: bill.createdByUserId, amount: shareAmount });
			}

			// Add to owed list
			const existingOwed = balances[bill.createdByUserId].owed.find((o) => o.fromUserId === share.userId);
			if (existingOwed) {
				existingOwed.amount += shareAmount;
			} else {
				balances[bill.createdByUserId].owed.push({ fromUserId: share.userId, amount: shareAmount });
			}
		}
	}

	return balances;
}

export async function setBillSharePaidStatus(billId: number, userId: string, isPaid: boolean, resetOffset?: boolean): Promise<void> {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const bill = await loadBill(billId);
	if (!bill) {
		throw new Error("Bill not found.");
	}

	const share = bill.shares.find((s) => s.userId === userId);
	if (!share) {
		throw new Error("User share not found on this bill.");
	}

	const now = isPaid ? new Date() : null;

	if (resetOffset) {
		const creatorId = bill.createdByUserId;
		// Revert offset for both sides (User A owing User B, and User B owing User A) inside this pool
		await pool.query(
			`UPDATE \`bill_share\` bs
			 INNER JOIN \`bill\` b ON bs.bill_id = b.id
			 SET bs.is_paid = 0, bs.offset_amount = 0.00, bs.paid_at = NULL
			 WHERE b.pool_id = ? 
			   AND ((bs.user_id = ? AND b.created_by_user_id = ?) OR (bs.user_id = ? AND b.created_by_user_id = ?))`,
			[bill.poolId, userId, creatorId, creatorId, userId],
		);
	} else {
		// Note: Explicitly setting paid status does NOT overwrite offset_amount. 
		// This preserves mutual offset states when toggling payments.
		await pool.query(
			"UPDATE `bill_share` SET is_paid = ?, paid_at = ? WHERE bill_id = ? AND user_id = ?",
			[isPaid ? 1 : 0, now, billId, userId],
		);
	}

	await pool.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [bill.poolId]);
}

export async function cancelOffsettingDebts(poolId: string, userAId: string, userBId: string): Promise<void> {
	const pool = getMySqlPool();
	if (!pool) {
		throw new Error("Database connection is not available.");
	}

	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();

		// Fetch all unpaid shares where userA owes userB (bill created by userB, userA is a share member)
		const [sharesAtoBRows] = await connection.query(
			`SELECT bs.id, bs.share_amount, bs.offset_amount, bs.is_paid 
			 FROM \`bill_share\` bs 
			 INNER JOIN \`bill\` b ON bs.bill_id = b.id 
			 WHERE b.pool_id = ? AND bs.user_id = ? AND b.created_by_user_id = ? AND bs.is_paid = 0
			 ORDER BY b.created_at ASC`,
			[poolId, userAId, userBId]
		);
		const sharesAtoB = (sharesAtoBRows as Array<Record<string, unknown>>).map(row => ({
			id: Number(row.id),
			shareAmount: parseFloat(String(row.share_amount)),
			offsetAmount: parseFloat(String(row.offset_amount || 0)),
		}));

		// Fetch all unpaid shares where userB owes userA (bill created by userA, userB is a share member)
		const [sharesBtoARows] = await connection.query(
			`SELECT bs.id, bs.share_amount, bs.offset_amount, bs.is_paid 
			 FROM \`bill_share\` bs 
			 INNER JOIN \`bill\` b ON bs.bill_id = b.id 
			 WHERE b.pool_id = ? AND bs.user_id = ? AND b.created_by_user_id = ? AND bs.is_paid = 0
			 ORDER BY b.created_at ASC`,
			[poolId, userBId, userAId]
		);
		const sharesBtoA = (sharesBtoARows as Array<Record<string, unknown>>).map(row => ({
			id: Number(row.id),
			shareAmount: parseFloat(String(row.share_amount)),
			offsetAmount: parseFloat(String(row.offset_amount || 0)),
		}));

		// Calculate total outstanding amounts
		let totalAtoB = sharesAtoB.reduce((sum, s) => sum + (s.shareAmount - s.offsetAmount), 0);
		let totalBtoA = sharesBtoA.reduce((sum, s) => sum + (s.shareAmount - s.offsetAmount), 0);

		if (totalAtoB <= 0 || totalBtoA <= 0) {
			// No offsetting possible
			await connection.commit();
			return;
		}

		// The amount to cancel is the minimum of the two totals
		const offsetAmount = Math.min(totalAtoB, totalBtoA);

		// Helper to apply offset to a list of shares
		const applyOffset = async (sharesList: typeof sharesAtoB, amountToReduce: number) => {
			let remaining = amountToReduce;
			for (const share of sharesList) {
				if (remaining <= 0) break;
				const outstanding = share.shareAmount - share.offsetAmount;
				if (outstanding <= remaining) {
					// This share is fully offset/paid
					const newOffsetAmount = share.shareAmount;
					await connection.query(
						"UPDATE `bill_share` SET is_paid = 1, offset_amount = ?, paid_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
						[newOffsetAmount, share.id]
					);
					remaining -= outstanding;
				} else {
					// This share is partially offset
					const newOffsetAmount = share.offsetAmount + remaining;
					await connection.query(
						"UPDATE `bill_share` SET offset_amount = ? WHERE id = ?",
						[newOffsetAmount, share.id]
					);
					remaining = 0;
				}
			}
		};

		// Apply the offset to both sides
		await applyOffset(sharesAtoB, offsetAmount);
		await applyOffset(sharesBtoA, offsetAmount);

		// Update pool activity timestamp
		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [poolId]);

		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		connection.release();
	}
}