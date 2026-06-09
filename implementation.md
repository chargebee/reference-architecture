# Goals

* Demonstrate how Chargebee features are used at scale and with best practices in mind

* Generate a detailed reference architecture with enough implementation details for an LLM to generate a working implementation in any stack

* Implement the reference architecture with an opinionated, scaleable and modern stack which can be made deployable as a demonstration of a SaaS using Chargebee at scale.

* Load test the implementation with generated data against a live Chargebee environment (dev/perf-test/etc)

# Implementation Notes

* Local dev environment should use docker compose to setup the required components like Postgres, Redis, etc

* Redis streams can be used in place of Kafka as an event bus to reduce complexity

* Clickhouse is the OLAP of choice as it scales well and offers usage event logging/filtering/aggregation over the billing period, and exposes it in the user analytics dashboard

# TODO

- [] Metered feature definitions + billing model (Fixed fee + overages) (https://www.chargebee.com/docs/billing/2.0/usage-based-billing/link-pricing) 

- [] Usage based alert thresholds (https://apidocs.chargebee.com/docs/api/alerts/create-an-alert)

- [] Credit based usage?? (once feature is rolled out)

- [] Which CB environment do we do real load testing on?

- [] Pooled usage limits for teams/enterprise offerings (https://apidocs.chargebee.com/docs/api/usage_summary/usage-summary-object)



## Best practices broken down by module

- How to handle webhooks
- How do you cache entitlements?
- When to use a feature vs "how" to use features
- Create a how-tos 
- Set of questions to help user make decisions on how to design/handle scenarios
- Easy to build out deployable app


## Preferred Stack

* Better Auth with the Chargebee Better Auth plugin

* Express or Next.js??

* ai-sdk for external LLM invocation, token usage tracking, etc

* Load testing - realistic seeding of data and basic load testing to ensure our SLOs/SLAs are achievable

Karthik: Pricing model: modify agent prompt 3 times for basic/ 10 time for middle/ unlimited for max

Retention: Do we use chargebee retention if the customer cancels the plan? What do we offer??

Do we offer this as an AWS SAM template?? or any one click deployment options?
