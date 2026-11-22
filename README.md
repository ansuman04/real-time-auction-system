# Real-Time Auction System — Portfolio Staging Copy

**Status: private staging copy; not yet approved for public release.**

Extracted from **Part 8** of a course-based Codex workshop project. Attribution to the original course and any third-party materials must be checked before public distribution. This is not a claim of independently originating all implementation.

## Architecture
- React + TypeScript / Fastify
- PostgreSQL transactions and row locking for competing bids
- Socket.IO + Redis for live updates
- RabbitMQ with transactional outbox for asynchronous close notifications
- Mock Stripe-style checkout and signed webhook processing (not live Stripe)
- OpenTelemetry + Jaeger tracing

## Local setup (requires Node 22.12+, npm, Docker Desktop, Python 3)

1. `python scripts/configure.py` — creates a **local ignored** `.env` with generated credentials.
2. `npm ci`
3. `npm start` — starts infrastructure, migrates, starts server/web/workers.
4. Open `http://localhost:5108`.
5. To run tests (after infrastructure is started, and preferably with app workers stopped): `npm test`.

**Note:** This automation has not been run on your Windows/Docker environment. The source copy must be checked with `npm ci`, typechecks, tests, a complete exercise of the app, and secret scanning before publication.

## Security and limitations
- Only local demo credentials are generated. Never use them in public deployments.
- `.env` is ignored and must never be committed.
- This package is not hardened for internet-facing deployment: the demo identity model has no production authentication/authorization system.
- The mock payment UI is demonstrative only; do not enter real card information.
- Run `gitleaks` on the new copy before publishing, and review dependencies, licenses, tests and logs.
- No original workshop Git history is included in this staging copy.
