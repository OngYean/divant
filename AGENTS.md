<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# System prompts

This project is a mobile PWA that has a mobile-friendly UI.

The most important principle is that it should be loginless, users simply create temporary "pool" sessions or join one.

## Detailed specifications

- Pool: a temporary session that can be created by anyone and assigned a name. a unique link with QR code should be generated to be shared to other users paying the bill. The pool should be temporary and will be destroyed upon the owner's deletion request, or after a certain amount of time of inactivity (value to be set in env). 

- Users joining a pool via the link will be prompted to enter a name. The same applies to users creating a new pool.

- Anyone in a pool can create a bill. They can specify whom to share the bill with, how the bill should be split (equal share, custom share or specific value).

- Multiple bills can exist in a pool. Each user gets to see how much they owes someone, and how much people owe them (many-to-many)

- User session persistence can be done via cookie. In case cookie is lost, the user can join back the same pool by entering their previously used name.

- Clearing Bills: Members can settle their outstanding share of a bill explicitly. Additionally, if two members mutually owe each other, either user can manually trigger a mutual debt offset/cancellation to reduce outstanding balances by the smaller mutual debt amount.

- Payment Status Tracking: Bill creators can view the payment progress (e.g. `2 / 5 paid`) of their bills and tap on it to view/toggle payment status for other members. Debtors can toggle/clear their own shares directly.

## Infrastructure

- Database: MySQL optimized for large amount of writes, initialize schema first if not found

- Unified backend and frontend

- Industry-standard rate limiting and other security implementations

- Follow standard Next.js coding conventions

## Target device

- Mobile (Android and iOS) Safari, Chromium and Gecko-based browser

- No offline support

## Deployment

- To be packed into a Docker image and hosted on a Linux VM

## Styling

- Use Tailwind CSS

- Avoid dependencies on fancy CSS modules

- Flat, Material-like design

- Minimal UI, prioritize large UI elements as the app will be run on small screens

## Environment config

- Pool timeout value

- MySQL connection credentials

- Create .env.example and exclude from .gitignore

## Key flow

- Create pool mechanism first

- Bill feature comes after completion of pool development

## Data model

- Keep the core model normalized and derive balances from bill shares.
- `pool` is the ownership/invitation boundary. One pool has many users and many bills.
- `user` belongs to exactly one pool. Store the display name, a normalized name for rejoin lookup, and the session cookie hash.
- `bill` belongs to exactly one pool and one creator. Store bill header data only here.
- Use a separate `bill_share` table for the many-to-many split. This is where equal, custom, and fixed splits live.
- Use random string IDs for externally visible records (`pool`, `user`) and auto-increment integers for write-heavy internal rows (`bill`, `bill_share` if needed).
- Suggested shape:
	- `pool(id<PK>: string, name, created_at, last_active_at, expires_at)`
	- `user(id<PK>: string, pool_id<FK>: pool, name, normalized_name, session_token_hash, is_owner, joined_at, last_seen_at)`
	- `bill(id<PK>: int, pool_id<FK>: pool, created_by_user_id<FK>: user, title, total_amount, currency, split_mode, created_at, updated_at)`
	- `bill_share(id<PK>: int, bill_id<FK>: bill, user_id<FK>: user, share_type, share_value, share_amount, is_paid, offset_amount, paid_at)`
- Constraints:
	- `user(pool_id, normalized_name)` should be unique so a lost cookie can rejoin the same pool by name.
	- `pool(id)` should be random enough for QR/link sharing and must be unique by definition.
	- `bill_share(bill_id, user_id)` should be unique.

## TODOs

- [ ] Re-enable payment link input and QR upload/decoding features on the frontend (currently hidden via commented-out React JSX elements in `app/pool-launcher.tsx`).