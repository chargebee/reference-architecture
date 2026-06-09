# Pointer - Chargebee Reference Architecture App

This app is an opinionated implementation of the Chargebee Reference Architecture for a medium to large SaaS company. The tech stack is as follows:

* Next.js 16.x - API and Webapp
* Better Auth - Authentication and related services
* Chargebee Better Auth plugin - Managing App <-> Chargebee sync, including processing webhooks
* PostgreSQL - Primary data store for relational data
* Redis - App cache, and usage streams
* Clickhouse - Event ingestion, aggregation and metrics
* BullMQ - Async jobs backed by Redis

# Planning

IMPORTANT: Save all plans to `plans` directory for auditing.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
