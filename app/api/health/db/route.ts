import { ensureMySqlSchema, isMySqlConfigured } from "../../../../lib/mysql";

export const runtime = "nodejs";

export async function GET() {
	if (!isMySqlConfigured()) {
		return Response.json(
			{
				ok: false,
				configured: false,
				ready: false,
				backend: "mysql",
				message: "Database credentials have not been added yet.",
				tables: [],
			},
			{ status: 200 },
		);
	}

	try {
		const status = await ensureMySqlSchema();
		return Response.json(
			{
				ok: true,
				...status,
			},
			{ status: 200 },
		);
	} catch (error) {
		return Response.json(
			{
				ok: false,
				configured: true,
				ready: false,
				backend: "mysql",
				message: error instanceof Error ? error.message : "Failed to initialize the database.",
				tables: [],
			},
			{ status: 503 },
		);
	}
}