# Chargebee Reference Architecture

**Status**: This is a work in progress - please expect continuous updates until it's marked ready for public consumption.

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./pointer/public/banner-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./pointer/public/banner-light.svg">
  <img alt="Chargebee Reference Architecture" src="./pointer/public/banner-light.svg" width="680">
</picture>

The purpose of this repository is to showcase the best practices around integrating Chargebee as the billing solution for a high-traffic AI/SaaS platform. This is split into two distinct parts:

- A collection of in-depth, technical how-tos which cover the Chargebee recommended best practices when integrating various billing and usage related Chargebee products

- An opinionated, fully functional and deployable application built to demonstrate how these concepts translate to code

## Audience

- Architects and solution consultants who are looking for Chargebee's recommended practices when integrating our products with their platform

- Developers who are looking to validate their integration code and ensure all edge-cases are covered

- LLMs and coding agents looking for authoritative sources for integrating Chargebee which are generalized and can be used to produce a working implementation using any tech stack

## What it covers

The topics below cover the best practices to achieve the required outcome and are vetted and updated continuously. They cover implementation details, edge cases to handle, testing scenarios, etc. To bridge the gap between documentation and implementation, each of these topics is actually implemented in code. The [Pointer](./pointer/README.md) app is our demo application built with an opinionated tech stack with all the required pieces to spin up a working SaaS platform. 

Regardless of your tech stack or hosting platform, each how-to covers the functional/non-functional requirements and a production go-live checklist to help you along the journey.

Each how-to is broken down into self-contained topics that addresses a specific scenario. It can include:

- Architecture or flow diagrams

- Pseudocode showing how certain cases may be structured in code

- Best practices to keep in mind, and testing scenarios which are useful in validating your implementation

- Do's and Don'ts

- An overview of how that topic is implemented in the demo app along with the relevant source files to look at

- A go-live checklist of must-do steps to pay attention to before your app gets deployed to production environments

These topics are written in plain Markdown with mermaid diagrams wherever possible. They are written and edited by humans, but can be consumed by agents as well.

## Where it fits in

While the Chargebee [docs](https://chargebee.com/docs) and [apidocs](https://apidocs.chargebee.com) serve as the main source of reference from the product and engineering teams, they aren't structured for consuming topics in thin vertical slices - something the content in this repo aims to do.

![information architecture](./pointer/public/information-architecture.png)

### Index

| Topic | Status | Last Updated |
|-------|--------|--------------|
| [Integrating Chargebee webhooks](./how-to/webhooks.md) | In Review | |
| [Enforcing entitlement checks](./how-to/entitlement-checks.md) | In Review | |
| [Sync Chargebee entities](./how-to/sync-chargebee-entities.md) | Draft | |
| [Usage based billing](./how-to/usage-based-billing.md) | Draft | |


## Reference App

<p align="center">
  <a href="https://pointer.chargebee-labs.com" target="_blank">
    <img src="./pointer/public/pointer-lockup-white.svg" />
  </a>
</p>

[Pointer](https://pointer.chargebee-labs.com) is our reference app which mimics an LLM/AI API provider that is PLG (product-led growth) driven. A developer signs up, uses their daily token allowance, and upgrades to Pro to keep going. Chargebee handles the subscription, entitlements, usage tracking and alerts.

It was built from the ground up with the help of coding agents and Chargebee's official libraries and SDK. Although a considerable amount of code was generated via LLMs, the architecture and design of the app, and the how-to topics themselves are completely written and reviewed by humans.

The purpose of building Pointer along with the how-to topics is to ensure that they cover practical aspects of integrating Chargebee with a monetizable product. 
We aim to continuously evolve and expand the reference architecture as we build out Pointer with additional features - this mimics how an actual product team would go about integrating billing, subscription, entitlement, and usage management into their app.

A high-level overview of the Pointer architecture is shown below. Further details on the tech stack, components, and infrastructure are provided in [ARCHITECTURE.md](./pointer/ARCHITECTURE.md).

![Pointer architecture](./pointer/public/pointer-components.svg)

## Links

- [How to](./how-to/README.md)
- [Pointer demo](https://pointer.chargebee-labs.com)
- [Pointer source](./pointer/README.md)
