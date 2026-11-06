import { afterEach, describe, expect, test } from "bun:test";
import { DNS, normalizeHostname, normalizeRecordName, registerDnsDriver, relativeName } from "@cloudgear/dns";
import { GandiDnsDriver } from "@cloudgear/dns/drivers/gandi";
import { MemoryDnsDriver } from "@cloudgear/dns/drivers/memory";
import { Route53DnsDriver } from "@cloudgear/dns/drivers/route53";

describe("DNS", () => {
  test("normalizes the domain and derives the zone from the last two labels", () => {
    const dns = new DNS("gandi", "CDN.Example.com.");
    expect(dns.domain).toBe("cdn.example.com");
    expect(dns.zone).toBe("example.com");
    expect(new DNS("gandi", "example.com").zone).toBe("example.com");
  });

  test("common second-level suffixes like co.uk default to three labels", () => {
    expect(new DNS("gandi", "cdn.example.co.uk").zone).toBe("example.co.uk");
    expect(new DNS("gandi", "www.example.com.au").zone).toBe("example.com.au");
    expect(new DNS("gandi", "cdn.example.co").zone).toBe("example.co");
    expect(new DNS("gandi", "a.b.example.org").zone).toBe("example.org");
  });

  test("an explicit zone covers registrations like example.co.uk", () => {
    const dns = new DNS("gandi", "cdn.example.co.uk", { zone: "example.co.uk" });
    expect(dns.zone).toBe("example.co.uk");
    expect(() => new DNS("gandi", "cdn.example.com", { zone: "other.org" })).toThrow(/not inside zone/);
  });

  test("rejects malformed domains", () => {
    for (const bad of ["", "localhost", "a_b.example.com", "-x.example.com", "https://x.example.com", "x..example.com"]) {
      expect(() => normalizeHostname(bad)).toThrow(/Invalid domain name/);
    }
  });

  test("record names may start labels with an underscore, site domains may not", () => {
    expect(normalizeRecordName("_abc123.cdn.example.com.")).toBe("_abc123.cdn.example.com");
    expect(() => normalizeRecordName("bad name.example.com")).toThrow(/Invalid record name/);
    expect(() => normalizeHostname("_abc.example.com")).toThrow(/Invalid domain name/);
  });

  test("relativeName is relative to the zone", () => {
    expect(relativeName("example.com", "example.com")).toBe("@");
    expect(relativeName("a.b.example.com", "example.com")).toBe("a.b");
    expect(() => relativeName("example.org", "example.com")).toThrow(/not inside zone/);
  });

  test("only touches names inside its own zone, through the driver", async () => {
    const driver = new MemoryDnsDriver();
    const dns = new DNS("gandi", "cdn.example.com", { driver });
    await dns.upsert({ name: "_x.cdn.example.com", type: "CNAME", values: ["v."] });
    expect(await dns.get("_X.cdn.example.com.", "CNAME")).toMatchObject({ values: ["v."] });
    await dns.remove("_x.cdn.example.com", "CNAME");
    expect(await dns.get("_x.cdn.example.com", "CNAME")).toBeNull();
    await expect(dns.upsert({ name: "evil.org", type: "CNAME", values: ["x."] })).rejects.toThrow(/not inside zone/);
  });

  describe("driver resolution", () => {
    const original = process.env.CLOUDGEAR_DNS_DRIVER;
    afterEach(() => {
      if (original === undefined) delete process.env.CLOUDGEAR_DNS_DRIVER;
      else process.env.CLOUDGEAR_DNS_DRIVER = original;
    });

    test("uses a registered driver, created lazily with the zone", async () => {
      const zones: string[] = [];
      registerDnsDriver("aws", (zone) => {
        zones.push(zone);
        return new MemoryDnsDriver();
      });
      const dns = new DNS("aws", "cdn.example.org");
      expect(zones).toEqual([]);
      await dns.get("cdn.example.org", "CNAME");
      await dns.get("cdn.example.org", "CNAME");
      expect(zones).toEqual(["example.org"]);
    });

    test("CLOUDGEAR_DNS_DRIVER=memory shares records per zone", async () => {
      process.env.CLOUDGEAR_DNS_DRIVER = "memory";
      await new DNS("gandi", "a.shared-zone.com").upsert({ name: "a.shared-zone.com", type: "CNAME", values: ["x."] });
      expect(await new DNS("gandi", "b.shared-zone.com").get("a.shared-zone.com", "CNAME")).toMatchObject({ values: ["x."] });
      expect(await new DNS("gandi", "a.other-zone.com").get("a.other-zone.com", "CNAME")).toBeNull();
    });
  });
});

describe("GandiDnsDriver", () => {
  const calls: { url: string; method: string; headers: Headers; body?: any }[] = [];
  const fakeFetch = (respond: (call: (typeof calls)[number]) => Response) =>
    (async (url: unknown, init: RequestInit) => {
      const call = { url: String(url), method: String(init.method), headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return respond(call);
    }) as typeof fetch;
  afterEach(() => {
    calls.length = 0;
    delete process.env.GANDI_TOKEN;
    delete process.env.GANDI_API_KEY;
  });

  test("PUTs the record relative to the zone, with a trailing dot on CNAME values", async () => {
    const driver = new GandiDnsDriver("example.com", { token: "pat", fetch: fakeFetch(() => new Response(null, { status: 201 })) });
    await driver.upsert({ name: "cdn.example.com", type: "CNAME", values: ["d111.cloudfront.net"], ttl: 600 });
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "https://api.gandi.net/v5/livedns/domains/example.com/records/cdn/CNAME",
      body: { rrset_values: ["d111.cloudfront.net."], rrset_ttl: 600 },
    });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer pat");
  });

  test("quotes TXT values, defaults the TTL and uses @ for the zone apex", async () => {
    const driver = new GandiDnsDriver("example.com", { token: "pat", fetch: fakeFetch(() => new Response(null, { status: 201 })) });
    await driver.upsert({ name: "example.com", type: "TXT", values: ["hello world"] });
    expect(calls[0]!.url).toEndWith("/records/@/TXT");
    expect(calls[0]!.body).toEqual({ rrset_values: ['"hello world"'], rrset_ttl: 300 });
    await driver.upsert({ name: "a.example.com", type: "A", values: ["192.0.2.1"], ttl: 60 });
    await driver.upsert({ name: "b.example.com", type: "A", values: ["192.0.2.1"], ttl: 99_999_999 });
    expect(calls.slice(-2).map((c) => (c.body as { rrset_ttl: number }).rrset_ttl)).toEqual([300, 2_592_000]);
  });

  test("get returns the record or null, remove tolerates a missing record", async () => {
    const driver = new GandiDnsDriver("example.com", {
      token: "pat",
      fetch: fakeFetch((call) =>
        call.url.includes("/found/")
          ? Response.json({ rrset_values: ["x."], rrset_ttl: 300 })
          : new Response("not found", { status: 404 }),
      ),
    });
    expect(await driver.get("found.example.com", "CNAME")).toEqual({ name: "found.example.com", type: "CNAME", values: ["x."], ttl: 300 });
    expect(await driver.get("nope.example.com", "CNAME")).toBeNull();
    await expect(driver.remove("nope.example.com", "CNAME")).resolves.toBeUndefined();
    expect(calls.at(-1)!.method).toBe("DELETE");
  });

  test("errors name the call and status but never the token", async () => {
    const driver = new GandiDnsDriver("example.com", { token: "super-secret-pat", fetch: fakeFetch(() => new Response("forbidden", { status: 403 })) });
    const error = await driver.upsert({ name: "cdn.example.com", type: "CNAME", values: ["x."] }).catch((e: Error) => e);
    expect((error as Error).message).toBe("Gandi PUT /domains/example.com/records/cdn/CNAME failed: 403 forbidden");
    expect((error as Error).message).not.toContain("super-secret-pat");
  });

  test("credentials come from the environment, token first, and are required", async () => {
    const respond = fakeFetch(() => new Response(null, { status: 201 }));
    await expect(new GandiDnsDriver("example.com", { fetch: respond }).upsert({ name: "a.example.com", type: "CNAME", values: ["x."] })).rejects.toThrow(/Gandi credentials missing/);

    process.env.GANDI_API_KEY = "legacy";
    await new GandiDnsDriver("example.com", { fetch: respond }).upsert({ name: "a.example.com", type: "CNAME", values: ["x."] });
    expect(calls.at(-1)!.headers.get("authorization")).toBe("Apikey legacy");

    process.env.GANDI_TOKEN = "pat";
    await new GandiDnsDriver("example.com", { fetch: respond }).upsert({ name: "a.example.com", type: "CNAME", values: ["x."] });
    expect(calls.at(-1)!.headers.get("authorization")).toBe("Bearer pat");
  });
});

describe("Route53DnsDriver", () => {
  function fakeRoute53(sets: any[] = [], zones: any[] = [{ Id: "/hostedzone/Z123", Name: "example.com.", Config: { PrivateZone: false } }]) {
    const calls: { name: string; input: any }[] = [];
    const client = {
      async send(command: any) {
        const name = command.constructor.name as string;
        calls.push({ name, input: command.input });
        if (name === "ListHostedZonesByNameCommand") return { HostedZones: zones };
        if (name === "ListResourceRecordSetsCommand") return { ResourceRecordSets: sets };
        return {};
      },
    };
    return { calls, client };
  }

  test("upserts into the hosted zone matched by exact name, looking the zone up once", async () => {
    const { calls, client } = fakeRoute53();
    const driver = new Route53DnsDriver("example.com", client);
    await driver.upsert({ name: "cdn.example.com", type: "CNAME", values: ["d111.cloudfront.net"], ttl: 60 });
    await driver.upsert({ name: "_v.example.com", type: "TXT", values: ["token"] });

    expect(calls.filter((c) => c.name === "ListHostedZonesByNameCommand")).toHaveLength(1);
    const changes = calls.filter((c) => c.name === "ChangeResourceRecordSetsCommand").map((c) => c.input);
    expect(changes[0]).toEqual({
      HostedZoneId: "Z123",
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: { Name: "cdn.example.com.", Type: "CNAME", TTL: 60, ResourceRecords: [{ Value: "d111.cloudfront.net" }] },
          },
        ],
      },
    });
    expect(changes[1].ChangeBatch.Changes[0].ResourceRecordSet.ResourceRecords).toEqual([{ Value: '"token"' }]);
  });

  test("remove repeats the stored record exactly, and does nothing for a missing one", async () => {
    const stored = { Name: "cdn.example.com.", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "d.cloudfront.net" }] };
    const present = fakeRoute53([stored]);
    await new Route53DnsDriver("example.com", present.client).remove("cdn.example.com", "CNAME");
    expect(present.calls.at(-1)!.input.ChangeBatch.Changes).toEqual([{ Action: "DELETE", ResourceRecordSet: stored }]);

    const absent = fakeRoute53([{ ...stored, Name: "other.example.com." }]);
    await new Route53DnsDriver("example.com", absent.client).remove("cdn.example.com", "CNAME");
    expect(absent.calls.some((c) => c.name === "ChangeResourceRecordSetsCommand")).toBe(false);
  });

  test("get maps the record set", async () => {
    const { client } = fakeRoute53([{ Name: "cdn.example.com.", Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: "d.cloudfront.net" }] }]);
    const driver = new Route53DnsDriver("example.com", client);
    expect(await driver.get("cdn.example.com", "CNAME")).toEqual({ name: "cdn.example.com", type: "CNAME", values: ["d.cloudfront.net"], ttl: 300 });
    expect(await driver.get("nope.example.com", "CNAME")).toBeNull();
  });

  test("fails clearly without a public hosted zone of that name", async () => {
    const privateOnly = fakeRoute53([], [{ Id: "/hostedzone/Z9", Name: "example.com.", Config: { PrivateZone: true } }]);
    await expect(new Route53DnsDriver("example.com", privateOnly.client).get("a.example.com", "CNAME")).rejects.toThrow(/No public Route 53 hosted zone named "example.com"/);
    const wrongName = fakeRoute53([], [{ Id: "/hostedzone/Z9", Name: "example.com.au.", Config: {} }]);
    await expect(new Route53DnsDriver("example.com", wrongName.client).get("a.example.com", "CNAME")).rejects.toThrow(/No public Route 53 hosted zone/);
  });
});

describe("a wildcard domain", () => {
  test("the zone is that of the base, and a wildcard covers exactly one label", async () => {
    const { DNS, wildcardCovers, isWildcardDomain, normalizeCertDomain } = await import("@cloudgear/dns");
    const dns = new DNS("gandi", "*.Example.com.");
    expect([dns.domain, dns.zone]).toEqual(["*.example.com", "example.com"]);
    expect(new DNS("gandi", "*.app.example.co.uk").zone).toBe("example.co.uk");
    expect(isWildcardDomain("*.example.com")).toBe(true);
    expect(wildcardCovers("*.example.com", "www.example.com")).toBe(true);
    expect(wildcardCovers("*.example.com", "example.com")).toBe(false);
    expect(wildcardCovers("*.example.com", "a.b.example.com")).toBe(false);
    expect(wildcardCovers("*.example.com", "www.other.com")).toBe(false);
    expect(wildcardCovers("www.example.com", "www.example.com")).toBe(true);
    expect(() => normalizeCertDomain("*.*.example.com")).toThrow(/Invalid domain name/);
    expect(() => normalizeCertDomain("a.*.example.com")).toThrow(/Invalid domain name/);
    expect(() => new DNS("gandi", "*.example.com", { zone: "other.com" })).toThrow(/not inside zone/);
  });
});
