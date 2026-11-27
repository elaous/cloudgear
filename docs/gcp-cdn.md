# A CDN for GCS website buckets

Status: proposal. Nothing in this document is built, and it needs two decisions from the project
owner (see "Decisions") before any code is written.

## What exists

- A `CDN` serves an AWS bucket or a function router from CloudFront. Its `Cert` is an ACM
  certificate validated through a `DNS` record, and `apply` creates the distribution, an origin access
  control and a bucket policy statement that lets the distribution read the (private) bucket.
- A GCS bucket can be a `BlobStoreWebSite` (website metadata, CORS, uploaded files), but it stays
  private: `publicAccessPrevention` is `enforced`, so nothing serves it to the internet. The
  `CDN` constructor, the analyzer and the schema reject a bucket whose provider is not `aws`, and
  `CdnProvider` and `CertProvider` have the single value `aws`.
- The AWS wiring is deep, not only a driver: the plan builds `@aws.Certificate` and `@aws.CloudFront`
  entries, pins a CDN certificate to `us-east-1`, adds DNS aliases to a CloudFront domain, and
  `PROVIDERS.aws.cdn` names those types. `DnsDriver` can write `A` records, which a Google front end
  needs (CloudFront uses `CNAME` or alias records).

## What a GCP front end is

Cloud CDN in front of a bucket is a global external HTTP(S) load balancer. The resources, in the order
they depend on each other (names are the Compute Engine API's; the request bodies MUST be checked
against the live API before they are relied on, since this environment cannot call it):

1. A global static IPv4 address (`addresses.insert`, `ipVersion: IPV4`).
2. A backend bucket (`backendBuckets.insert`) with `bucketName` and `enableCdn: true`, and a CDN
   policy (cache mode for static content).
3. A Google-managed SSL certificate (`sslCertificates.insert`, `type: MANAGED`, `managed.domains`).
4. A URL map (`urlMaps.insert`) whose default service is the backend bucket.
5. A target HTTPS proxy (`targetHttpsProxies.insert`) with the URL map and the certificate.
6. A global forwarding rule (`globalForwardingRules.insert`) from the address on port 443 to the proxy.
7. An `A` record for the domain pointing at the address, written with the `DNS` driver.

Optionally a second forwarding rule and a URL map that redirect HTTP to HTTPS.

Each insert returns a long-running operation that MUST be waited on. Removal is the reverse order, and
each step MUST tolerate "not found". The load balancer's certificate is issued only after the domain's
`A` record points at the address, and issuance can take tens of minutes, so `apply` SHOULD record the
resources and report "certificate provisioning" without blocking until it finishes. `cloudgear`'s
existing `status` flow for a CDN (`describe`) is the place to show it.

## The access problem

A backend bucket serves objects as an anonymous reader, so the objects have to be readable by
`allUsers`, or the requests have to be signed.

- **Public read (`allUsers` as `roles/storage.objectViewer`).** This is how a public website on GCS is
  usually done. It turns off the bucket's private-by-default posture for every object in it, not only
  the site's files, and it requires turning off `publicAccessPrevention`. It is the one change in this
  proposal that exposes data, so it MUST be explicit and visible in `plan`.
- **Signed URLs or cookies.** The Cloud CDN service agent reads the bucket and viewers must present a
  signature. That keeps the bucket private but is not a public website; it fits downloads, not a site.
- **A private origin.** Cloud CDN does not offer an equivalent of CloudFront's origin access control
  for a backend bucket, so there is no way to keep the bucket private and serve it anonymously.

The proposal is public read, behind an explicit opt-in on the bucket (for example
`options: { public_read: "true" }`). Without it, a `CDN` on a GCS bucket MUST fail with an error that
says what the option does. `plan` MUST show the binding as a change, `import` MUST leave an imported
bucket alone as everywhere else, and `destroy` MUST remove only the binding cloudgear added.

## What changes in cloudgear

- Schema: `CdnProvider` and `CertProvider` gain `gcp`; `Cdn.bucket` accepts a `BlobStore` with provider
  `gcp`. A GCP certificate is not validated through DNS, so `Cert` has no use for its `dns` reference in
  the same way: the domain list comes from the `Cdn`, and the `DNS` is only where the `A` record goes.
  Whether `Cert` stays a separate kind for GCP or is folded into the `Cdn` is part of the design.
- `PROVIDERS.gcp.cdn` with new resource types (for example `@gcp.GlobalAddress`, `@gcp.BackendBucket`,
  `@gcp.ManagedCertificate`, `@gcp.UrlMap`, `@gcp.HttpsProxy`, `@gcp.ForwardingRule`), or one
  `@gcp.CloudCdn` entry whose driver creates and removes the whole chain. One entry is simpler to plan
  and to roll back; separate entries show each resource in `plan`. I recommend one entry.
- The analyzer, `CDN` class, `generate`, and `plan` stop assuming AWS: the `us-east-1` rule, the alias
  to a CloudFront domain, the attached-origins feature, `invalidate`, `check-dns` and the DNS record
  type all need a provider switch.
- A new driver under `src/deploy/gcp/`, using the `http` client the function driver already has, with
  fakes for tests.
- Permissions for the deploying identity: `compute.globalAddresses.*`, `compute.backendBuckets.*`,
  `compute.sslCertificates.*`, `compute.urlMaps.*`, `compute.targetHttpsProxies.*`,
  `compute.globalForwardingRules.*`, `compute.globalOperations.get`, and `storage.buckets.setIamPolicy`
  for the public-read binding.
- Cost: a global forwarding rule and a reserved address are billed while they exist. The README MUST say
  so.

## What cannot be tested here

Every driver in this repository is tested against fakes. For this one the risk is higher: the request
shapes, the operation waiting, the certificate lifecycle and the quota errors are exactly what a fake
cannot show. Before it is released it SHOULD be run once against a real project with a throwaway
domain, with the steps and expected results written down in the pull request.

## Decisions

1. **Public read.** Is it acceptable that a CDN on a GCS bucket makes that bucket's objects public, with
   the explicit opt-in described above? If not, the only alternative is signed access, which is not a
   website.
2. **Certificates.** Google-managed certificates need the `A` record in place before they issue, so the
   first `apply` leaves the site without HTTPS for a while. Is that acceptable, or should the design
   use Certificate Manager with DNS authorization, which can issue before the load balancer serves
   traffic but adds more resources and a DNS validation record?

## Build order

1. Schema and class changes, with the GCP provider rejected at `apply` until the driver exists.
2. The driver, against fakes, for create, update, delete and the certificate states.
3. DNS `A` record, `status`, and `plan` output.
4. A documented run against a real project.
