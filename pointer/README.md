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
