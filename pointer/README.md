# Pointer

## Requirements

* Node.js >= v22
* PNPM >= 11
* Docker
* Terraform (for deploying infra)

## Getting Started

1. Copy `.env.example` to `.env.local` and fill out the environment variables to configure the app

2. Run `docker compose up -d` to bring up the required services

3. Run `pnpm run db:migrate:local` to create the required schema in PostgreSQL

4. `pnpm dev` to start the server

Open [http://localhost:3000](http://localhost:3000) in your browser to play around!

### Processing webhook events

To receive and proces webhook events from Chargebee, use a tunneling service like [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) or [ngrok](https://ngrok.com/) to forward events to your local setup. Once you have a [tunnel setup](https://www.chargebee.com/docs/billing/2.0/kb/platform/how-to-test-webhooks-on-staging-which-requires-vpn), run `pnpm run worker:chargebee` to start the background worker.

The incoming webhook events are pushed to the LocalStack SQS queue, which is polled and processed by the webhook worker.

