# TODOs

- [x] Fix better auth Chargebee plugin to follow our best practices in webhook handling and handle the subscription related events using that.

- [ ] Show plans and allow logged in user to subscribe

- [ ] Mocking traffic: as a "authorized" user, have a few simulator options in the pointer dashboard, which can:

    - Create 10,000 users with mocked data
    - See how the system responds to the traffic
    - Setup automatic scaling in the AWS infra to handle this traffic
    - Include any PG/Redis partitioning/scaling as required

- [ ] Integrate pricing page using automicpricing

-  How-Tos:
    - [ ] How to keep Chargebee entities in sync (subscription/plans/coupons/etc) - what are the schedules for updating them, and any other caching logic

    - [ ] Tracking usage locally - caching, synching with UBB, metered features, lock-out on exceeding limits, etc

    - [ ] Prepaid credits - where does it fit, how does it play well with the UBB usages, etc

    - [ ] Overages - like cursor, how do we have a base usage attached to the plan, but have an extra $100 for additional usage?

    - [ ] Pooling usage tokens for team/enterprise plans
