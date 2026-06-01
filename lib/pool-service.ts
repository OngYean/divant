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
	lastActionAt: string;
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

async function loadPoolRecord(poolId: string) {
	const pool = getMySqlPool();
	if (!pool) {
		return null;
	}

	const [poolRows] = await pool.query(
		"SELECT id, name, created_at, last_active_at, last_action_at, expires_at FROM `pool` WHERE id = ? LIMIT 1",
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
			lastActionAt: toIsoTimestamp(poolRow.last_action_at),
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
			"INSERT INTO `pool` (id, name, created_at, last_active_at, last_action_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
			[poolId, normalizedPoolName, now, now, now, expiresAt],
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

		await connection.query("UPDATE `pool` SET last_active_at = CURRENT_TIMESTAMP(3), last_action_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [normalizedPoolId]);
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