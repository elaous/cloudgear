# A CDN for GCS website buckets

Status: built, tested against fakes only. The owner approved decision 1 (public read behind an
explicit opt-in) and decision 2 (Certificate Manager). Differences from this proposal: the
certificate is its own `@gcp.Certificate` entry that `@gcp.CloudCdn` depends on, the bucket driver
owns `publicAccessPrevention` (set from `public_read` on create and update), a `path` on a gcp CDN
is rejected, and `status`, `invalidate` and `check-dns` are implemented. The run against a real
project (build step 4) has not been done; request shapes follow the public API reference and are
unverified against live services. The sections below keep the original proposal.

## What exists

- A `CDN` serves an AWS bucket or a function router from CloudFront. Its `Cert` is an ACM
  certificate validated through a `CNAME` record that `apply` writes with the `DNS` driver. `apply`
  creates the distribution, an origin access control and a bucket policy statement that lets the
  distribution read the (private) bucket, and writes a `CNAME` from the domain to the distribution.
- A GCS bucket can be a `BlobStoreWebSite` (website metadata, CORS, uploaded files), but it stays
  private: `publicAccessPrevention` is `enforced` at creation, so nothing serves it to the internet.
- `CdnProvider` and `CertProvider` have the single value `aws` (`cdn.proto`, `cert.proto`). The `CDN`
  constructor and the analyzer reject a bucket or certificate whose provider is not `aws`. The schema
  and the config reader do not: `Cdn.bucket` only references a `BlobStore`, and the plan does not check
  its provider, so a hand-written config with a GCS bucket reaches the plan unchecked.
- The AWS wiring is more than a driver. The plan builds `@aws.Certificate` and `@aws.CloudFront`
  entries through `PROVIDERS.aws.cdn`, requires a certificate with usage `cdn`, pins it to `us-east-1`,
  and `CdnDriver`/`CertDriver` in `packages/cdn` (the status drivers behind `CDN.status()` and `url()`)
  have `aws` as their only built-in. `attached origins`, `invalidate` and `check-dns` are CloudFront
  features.
- `DNS_PROVIDERS` is `gandi` and `aws`. There is no Cloud DNS driver. `DnsDriver` can write `A`
  records.

## What a GCP front end is

Cloud CDN in front of a bucket is a global external HTTP(S) load balancer. The resources, in the order
they depend on each other (names are the Compute Engine API's; every request body MUST be checked
against the live API before it is relied on, since this environment cannot call it):

1. A global static IPv4 address (`addresses.insert`). IPv4 only: a domain that also has an `AAAA`
   record that does not point at the load balancer stops a managed certificate from issuing.
2. A backend bucket (`backendBuckets.insert`) with `bucketName` and `enableCdn: true`, and a CDN
   policy (cache mode for static content).
3. A certificate (see decision 2).
4. A URL map (`urlMaps.insert`) whose default service is the backend bucket.
5. A target HTTPS proxy (`targetHttpsProxies.insert`) with the URL map and the certificate.
6. A global forwarding rule (`globalForwardingRules.insert`) from the address on port 443 to the proxy.
   It needs a `loadBalancingScheme` (`EXTERNAL_MANAGED`, or the classic `EXTERNAL`) and a `portRange`;
   the scheme decides which load balancer type, price and quota apply, and this proposal uses
   `EXTERNAL_MANAGED` unless the live check shows a backend bucket does not support it.
7. An HTTP to HTTPS redirect: a second URL map with a redirect, a target HTTP proxy
   (`targetHttpProxies.insert`) and a forwarding rule on port 80. Without it port 80 does not answer at
   all, which is wrong for a website, so it MUST be part of the first version.
8. An `A` record for the domain pointing at the address, written with the `DNS` driver. It MUST use the
   same ownership guard as the CloudFront `CNAME` (refuse to overwrite a conflicting record), and
   `destroy` MUST remove it first.

Every insert returns a global operation that MUST be waited on (`globalOperations.wait`). The Compute
operation polling is new code; the function driver's `waitFor` is private to its module. Removal is the
reverse order, each step MUST tolerate "not found", and the global network tier MUST be Premium.

**Updates.** Certificates are immutable: a changed domain list means creating a new certificate,
calling `targetHttpsProxies.setSslCertificates`, then deleting the old one. A changed backend bucket
or cache policy is a `patch`, and a changed URL map on the proxy is `setUrlMap`.

**Issuance.** A classic Google-managed certificate issues only after the domain's `A` record points at
the address and the certificate is attached to a proxy with a forwarding rule. That can take tens of
minutes, sometimes hours, so `apply` SHOULD record the resources and report "certificate
provisioning" without blocking; `CDN.status()` through the `describe` driver is where it is shown.

## The access problem

A backend bucket serves objects to anonymous viewers, so the objects have to be readable by `allUsers`
or the requests have to be signed.

- **Public read.** This is how a public website on GCS is usually done. It needs
  `publicAccessPrevention` set to `inherited` (it is `enforced` today), and it makes every object in
  the bucket readable, not only the site's files. `roles/storage.objectViewer` for `allUsers` also lets
  anyone list the bucket through the JSON API; `roles/storage.legacyObjectReader` reads objects without
  listing them, so this proposal uses the legacy role. An organization can forbid it with the
  `constraints/storage.publicAccessPrevention` policy or with domain-restricted sharing
  (`iam.allowedPolicyMemberDomains`); `apply` MUST name those two in its error when the binding is
  refused. With uniform bucket-level access on, IAM is the only route, which is what is used.
- **Signed URLs or cookies.** The Cloud CDN service agent reads the bucket and viewers must present a
  signature. The bucket stays private, but that is not a public website; it fits downloads.
- **Other designs** keep the bucket private for a Cloud CDN *backend bucket* only by leaving the
  backend bucket (a serverless backend or a proxy function in front of the bucket, or Media CDN with a
  private origin, which is a different product). This proposal does not pursue them.

The proposal is public read behind an explicit opt-in on the bucket (`options: { public_read: "true" }`,
a new `@gcp.GCS` option). The CDN causes the exposure, so the CDN owns the binding: a `CDN` on a GCS
bucket without the option MUST fail at `plan` with an error that says what the option does. `plan`
MUST show the binding as a change. An imported bucket is never changed, so a `CDN` on an imported
bucket MUST fail at `plan` unless the bucket is already public, and the error MUST say so. `destroy`
MUST remove only the binding cloudgear added, through the existing `changeGrant` (get, modify, set with
a retry), and MUST set `publicAccessPrevention` back to `enforced` only if cloudgear changed it.

### Later option: a signing function in front of a private bucket

Not built now. A GCP function takes a request such as `<function url>?path=<bucket>/path/to/image`,
checks it, signs the object, and returns the image (by proxying the bytes) or a redirect to a
short-lived signed URL. The bucket stays private with `publicAccessPrevention` `enforced`, so no
`public_read` and no `allUsers` binding is needed, and the function's service account is the only
reader.

- **Fits** images and downloads that a page references by URL, where the owner wants the bucket to stay
  private and does not need the whole bucket served as a website. It could be a `FunctionRouter`
  route, so cloudgear already deploys it, and its service account gets read access through the
  existing `permissions` and grants.
- **Signing** uses the service account through IAM Credentials `signBlob`, so no key file exists;
  that needs `roles/iam.serviceAccountTokenCreator` on the account itself. Signed URLs expire, so a
  redirect response MUST NOT be cached longer than the signature lives.
- **Must have** an allowed-bucket and allowed-prefix list, held in the function's declaration and not
  taken from the request; otherwise the `path` parameter lets any caller sign any object the service
  account can read. It MUST reject `..` segments and other buckets, and SHOULD restrict methods to
  `GET` and `HEAD`.
- **Cost** is a function invocation per image, which the CDN does not remove unless the function sits
  behind Cloud CDN too (a serverless backend with a cache); proxying the bytes also costs egress and
  latency through the function. Redirecting avoids both but exposes a signed URL that works until it
  expires.
- **Does not give** a website: index and not-found pages, clean paths and directory indexes would have
  to be reimplemented in the function.

This is an alternative to the public-read decision, not a replacement for the CDN: it could ship
first for owners who refuse a public bucket. The owner decides whether it becomes a build step.

## What changes in cloudgear

- **Schema.** `CdnProvider` and `CertProvider` gain `gcp`; `generate` MUST regenerate the constants.
  `PriceClass`, `web_acl`, `web_acl_arn` and `method_routing` are CloudFront-only and MUST be rejected
  for `gcp`. A `Cdn` with a `router` origin MUST be rejected for `gcp` (only a bucket origin is
  designed). Attached origins have no Cloud CDN equivalent and are rejected.
- **Config and plan.** `ProviderProfile.cdn` is `{ type, certificate }` and the plan throws unless a
  certificate with usage `cdn` exists. A GCP front end puts the certificate inside the chain, so the
  profile shape, the usage rules, the `us-east-1` pin and the DNS record (`A`, not `CNAME`) become
  provider-specific, and the plan MUST check that a CDN's bucket provider equals the CDN's.
- **Entries and state.** One entry, `@gcp.CloudCdn`, whose driver creates and removes the chain. The
  entry's state outputs MUST hold the address, every resource name, the certificate name and kind, the
  `A` record, and whether cloudgear added the public binding and changed `publicAccessPrevention`.
  They MUST be written after each step, so a failure partway is a `PartialApplyError` whose next
  `apply` finishes the chain, and `destroy` removes exactly what the outputs list. This proposal
  prefers one entry because it keeps the chain in one rollback unit; separate entries would show each
  resource in `plan` at the price of ordering rules between them.
- **Physical names.** Compute names are at most 63 lowercase letters, digits and hyphens. A name is the
  project, the logical name and a short hash of the domain, cut to fit, so two CDNs in a project do
  not collide.
- **Drivers.** A driver under `src/deploy/gcp/` using the `http` client for the Compute (and, with
  decision 2, Certificate Manager) APIs and the Storage client for the bucket binding; a `describe`
  driver in `packages/cdn/drivers/` and a certificate status driver for `CDN.status()`.
- **Other commands.** `invalidate` can be implemented (`urlMaps.invalidateCache`). `check-dns` needs the
  new address in its endpoint table. `import` and adoption of an existing load balancer are out of
  scope and MUST say so.
- **`@gcp.GCS` options.** `public_read` needs a rule in `src/providers.ts`, and the bucket driver
  MUST apply and clear `publicAccessPrevention` and the binding on `update`, not only on `create`.
- **Multiple CDNs.** The analyzer allows several site CDNs. Each gets its own address, load balancer and
  forwarding rule in this proposal, so global forwarding rules, static addresses, certificates, URL
  maps and backend buckets per project are all limits to hit, and the cost multiplies. A shared URL map
  would avoid that and is left for later.
- **Permissions** for the deploying identity. Custom roles take no wildcards, so the README MUST list
  each: `compute.globalAddresses.{create,get,delete,use}`, `compute.backendBuckets.{create,get,update,
  delete,use}`, `compute.sslCertificates.{create,get,delete,use}`, `compute.urlMaps.{create,get,update,
  delete,use,invalidateCache}`, `compute.targetHttpsProxies.{create,get,update,delete,use,setSslCertificates,
  setUrlMap}`, `compute.targetHttpProxies.{create,get,delete,use}`, `compute.globalForwardingRules.
  {create,get,delete,setTarget}`, `compute.globalOperations.get`, and on the bucket
  `storage.buckets.{get,update,getIamPolicy,setIamPolicy}`. The Compute Engine API MUST be enabled in
  the project. A Certificate Manager certificate adds that API's permissions.
- **Cost.** A global forwarding rule, a reserved address, Cloud CDN cache egress and cache-fill, and
  load balancer data processing are billed. The README MUST say so.

## What cannot be tested here

Every driver in this repository is tested against fakes. For this one the risk is higher: the request
shapes, operation waiting, certificate lifecycle and quota errors are what a fake cannot show. One
point also needs the live service to settle: whether a backend bucket serves the bucket's website
settings (`mainPageSuffix`, `notFoundPage`) or only plain object paths. Before release it SHOULD be run
once against a real project with a throwaway domain, with the steps and expected results written down
in the pull request.

## Decisions

1. **Public read (the owner's decision).** May a CDN on a GCS bucket make that bucket's objects public,
   with the opt-in and the `legacyObjectReader` role described above? For a Cloud CDN backend bucket the
   only other choice is signed access, which is not a website. If the answer is no, or no answer comes,
   nothing is built.
2. **Certificates (a recommendation).** This proposal uses Certificate Manager with DNS authorization
   for every certificate. It issues before the load balancer serves traffic, so the first `apply` does
   not leave the site without HTTPS for long; it supports wildcard domains, which cloudgear's `Cert`
   and `CDN` already accept and a classic managed certificate does not; and it gives one code path.
   The cost is more resources (`dnsAuthorizations`, `certificates`, `certificateMaps`,
   `certificateMapEntries`), a `_acme-challenge` `CNAME` that cloudgear writes, a separate API with its
   own enablement and permissions, and a certificate map instead of a certificate on the proxy. The
   owner MAY prefer classic managed certificates for exact domains first; that is a smaller first
   version and can be added to later.

## Build order

1. Schema, profile, plan and class changes, with the GCP provider rejected at `apply` until the driver
   exists (this MUST be an error, not a skip).
2. The driver, against fakes, for create, update, delete, the certificate states and a failure after
   each step.
3. The `A` record, `status`, `invalidate` and `plan` output.
4. The documented run against a real project.
