This directory contains temporary, locally packed Chargebee packages used by
the Docker build until the packages can be published to npm.

Rebuild the packages in `js-framework-adapters`, then create the artifacts with:

```sh
pnpm --filter @chargebee/entitlements pack --out /path/to/pointer/vendor/chargebee-entitlements.tgz
pnpm --filter @chargebee/openfeature pack --out /path/to/pointer/vendor/chargebee-openfeature.tgz
```
